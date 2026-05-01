const config = require('./config');
const { getHistoricalBars } = require('./dataFeed');
const { hasRecentRelevantNews } = require('./newsAnalyzer');
const { getLatestMt5Quote } = require('./mt5Bridge');
const { calculateRiskMetrics, summarizeMarketContext } = require('./strategy');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getSpreadMetrics(quote = {}) {
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const price = Number(quote.price);

  if (!(Number.isFinite(bid) && Number.isFinite(ask) && Number.isFinite(price) && price > 0 && ask >= bid)) {
    return {
      spread: null,
      spreadPct: null,
    };
  }

  return {
    spread: ask - bid,
    spreadPct: (ask - bid) / price,
  };
}

function addCheck(checks, name, passed, score = 0, note = '') {
  checks.push({ name, passed, score, note });
  return passed ? score : 0;
}

function getSessionBucket(sessionLabels = [], referenceTimeMs = Date.now()) {
  const labels = Array.isArray(sessionLabels)
    ? sessionLabels.map((label) => String(label || '').toUpperCase())
    : [];
  const hasLondon = labels.includes('LONDON');
  const hasNewYork = labels.includes('NEWYORK');
  const hour = new Date(referenceTimeMs).getUTCHours();

  if (!hasLondon && !hasNewYork) {
    return 'ASIA';
  }

  if (hasLondon && hasNewYork) {
    return 'LONDON_NEWYORK_OVERLAP';
  }

  if (hasLondon) {
    return 'LONDON';
  }

  return hour >= 19 ? 'LATE_NEWYORK' : 'NEWYORK';
}

async function buildDecisionContext(profile, candidate, options = {}) {
  const quote = options.quote || (profile.dataSource === 'mt5' ? await getLatestMt5Quote(profile.symbol) : { price: Number(candidate.entry) || null });
  const bars = options.bars || await getHistoricalBars(profile, {
    count: Math.max(config.strategy.lookbackBars, config.strategy.longMa + 20),
    timeframe: candidate.timeframe || config.strategy.timeframe,
  });
  const marketContext = summarizeMarketContext(bars, {
    currentTimeMs: Date.now(),
  });
  const newsRisk = await hasRecentRelevantNews(profile.symbol, config.strategy.newsCooldownMinutes);

  return {
    quote,
    marketContext,
    newsRisk,
  };
}

async function evaluateHybridDecision(profile, candidate = {}, options = {}) {
  const symbol = String(profile.symbol || candidate.symbol || '').toUpperCase();
  const settings = config.getSymbolSettings(symbol);
  const sourceType = String(options.sourceType || candidate.source || profile.signalSource || '').toUpperCase();
  const decisionContext = await buildDecisionContext(profile, candidate, options);
  const { quote, marketContext, newsRisk } = decisionContext;
  const spreadMetrics = getSpreadMetrics(quote);
  const direction = String(candidate.direction || candidate.side || candidate.signal || '').toUpperCase();
  const biasDirection = String(candidate.biasDirection || '').toUpperCase();
  const biasStrength = String(candidate.biasStrength || 'none').toLowerCase();
  const strategyReasons = Array.isArray(candidate.strategyReasons) ? candidate.strategyReasons : [];
  const signalAgeMinutes = Number(candidate.signalAgeMinutes);
  const entry = Number(candidate.entry);
  const livePrice = Number(quote.price);
  const entryDeviationPct = Number.isFinite(entry) && Number.isFinite(livePrice) && livePrice > 0
    ? Math.abs(livePrice - entry) / livePrice
    : null;
  const signalConfluence = options.signalConfluence || { count: 0, consensusDirection: null };
  const checks = [];
  const reasons = [];
  const blocks = [];
  let score = 0;
  const strategyName = String(candidate.strategyName || '').toLowerCase();
  const setupType = String(candidate.setupType || '').toLowerCase();
  const indicators = candidate.indicators && typeof candidate.indicators === 'object' ? candidate.indicators : {};
  const riskMetrics = calculateRiskMetrics(
    direction,
    candidate.entry ?? quote.price,
    candidate.stopLoss,
    candidate.takeProfits,
    { spread: spreadMetrics.spread },
  );
  const rrTp1 = Number.isFinite(Number(candidate.rrTp1)) ? Number(candidate.rrTp1) : riskMetrics.rrTp1;
  const rrFinal = Number.isFinite(Number(candidate.rrFinal)) ? Number(candidate.rrFinal) : riskMetrics.rrFinal;
  const h1Bias = indicators.h1Bias && typeof indicators.h1Bias === 'object' ? indicators.h1Bias : {};
  const triggerCandle = indicators.triggerCandle && typeof indicators.triggerCandle === 'object' ? indicators.triggerCandle : {};
  const h1BiasDirection = String(h1Bias.direction || '').toUpperCase();
  const h1BiasAligned = h1BiasDirection === direction;
  const triggerConfirmed = direction === 'BUY'
    ? Boolean(triggerCandle.longConfirmed)
    : direction === 'SELL'
      ? Boolean(triggerCandle.shortConfirmed)
      : false;
  const recentFailedZone = candidate.recentFailedZone && typeof candidate.recentFailedZone === 'object'
    ? candidate.recentFailedZone
    : null;
  const sameThesisAttemptCount = Number(candidate.sameThesisAttemptCount || 0);

  if (direction !== 'BUY' && direction !== 'SELL') {
    const checks = [{ name: 'direction', passed: false, score: 0, note: 'No executable direction' }];
    let score = 0;
    const reasons = strategyReasons.length > 0 ? [...strategyReasons] : ['no_direction'];
    const blocks = ['no_direction'];
    const emaFast = Number(indicators.emaFast);
    const emaSlow = Number(indicators.emaSlow);
    const emaSeparationAtr = Number(indicators.emaSeparationAtr);
    const priceTooStretched = reasons.includes('price_too_stretched');
    const priceSlightlyStretched = reasons.includes('price_slightly_stretched');
    const cleanEmaAlignment = (biasDirection === 'BUY' && emaFast > emaSlow)
      || (biasDirection === 'SELL' && emaFast < emaSlow);

    if (biasDirection === 'BUY' || biasDirection === 'SELL') {
      const biasScore = biasStrength === 'strong' ? 45 : biasStrength === 'moderate' ? 30 : 15;
      score += addCheck(checks, 'directional_bias', true, biasScore, `${biasDirection}:${biasStrength}`);

      if (marketContext.trendBias === biasDirection) {
        score += addCheck(checks, 'trend_bias_alignment', true, 10, marketContext.trendBias);
      }

      const sessionLabels = Array.isArray(marketContext.sessionLabels) ? marketContext.sessionLabels : [];
      const sessionMatch = settings.allowedSessions.length === 0
        || sessionLabels.some((label) => settings.allowedSessions.includes(label));
      score += addCheck(checks, 'session_filter', sessionMatch, 5, sessionLabels.join(', ') || 'none');

      if (marketContext.regime === 'DEAD') {
        blocks.push('regime_dead');
        reasons.push('regime_dead');
      } else if (marketContext.regime === 'UNSTABLE') {
        checks.push({ name: 'regime_filter', passed: false, score: -10, note: marketContext.regime });
        score -= 10;
        reasons.push('regime_unstable');
      }

      if (priceTooStretched) {
        blocks.push('price_too_stretched');
      }

      const canPromoteMildStretchBias = symbol === 'EURUSD'
        && strategyName === 'bias'
        && priceSlightlyStretched
        && !priceTooStretched
        && biasStrength === 'strong'
        && cleanEmaAlignment
        && Number.isFinite(emaSeparationAtr)
        && emaSeparationAtr >= 0.08
        && marketContext.trendBias === biasDirection;

      if (canPromoteMildStretchBias) {
        const unstableBonus = marketContext.regime === 'UNSTABLE' ? 12 : 8;
        score += addCheck(
          checks,
          'mild_stretch_bias_promotion',
          true,
          unstableBonus,
          `${strategyName}:${biasDirection}:${biasStrength}`,
        );
      }
    }

    const normalizedScore = clamp(Math.round(score), 0, 100);
    return {
      decision: blocks.includes('regime_dead') || blocks.includes('price_too_stretched')
        ? 'REJECT'
        : normalizedScore >= settings.minWatchScore ? 'WATCH' : 'REJECT',
      score: normalizedScore,
      checks,
      reasons,
      blocks,
      context: { symbol, sourceType, settings, quote, marketContext, signalConfluence, newsRisk, biasDirection, biasStrength },
    };
  }

  if (String(settings.mode).toUpperCase() === 'SIGNAL_ONLY' && sourceType === 'STRATEGY') {
    blocks.push('signal_only_mode');
    reasons.push('symbol configured for signal-only mode');
  }

  if (String(settings.mode).toUpperCase() === 'STRATEGY_ONLY' && sourceType === 'TELEGRAM') {
    blocks.push('strategy_only_mode');
    reasons.push('symbol configured for strategy-only mode');
  }

  if (!settings.allowTelegramTrigger && sourceType === 'TELEGRAM') {
    reasons.push('telegram used as confluence only');
  }

  const sessionLabels = Array.isArray(marketContext.sessionLabels) ? marketContext.sessionLabels : [];
  const sessionBucket = getSessionBucket(sessionLabels, Date.now());
  const sessionMatch = settings.allowedSessions.length === 0
    || sessionLabels.some((label) => settings.allowedSessions.includes(label));
  score += addCheck(checks, 'session_filter', sessionMatch, 10, sessionLabels.join(', ') || 'none');
  if (!sessionMatch) {
    blocks.push('session_filter');
    reasons.push(`outside allowed sessions (${sessionLabels.join(', ') || 'none'})`);
  }

  const spreadOk = !Number.isFinite(spreadMetrics.spreadPct) || spreadMetrics.spreadPct <= settings.maxSpreadPct;
  score += addCheck(checks, 'spread_filter', spreadOk, 10, Number.isFinite(spreadMetrics.spreadPct) ? String(spreadMetrics.spreadPct) : 'n/a');
  if (!spreadOk) {
    blocks.push('spread_filter');
    reasons.push('spread too wide');
  }

  const volatilityOk = Number.isFinite(marketContext.atrPct) ? marketContext.atrPct >= config.strategy.minAtrPct : true;
  score += addCheck(checks, 'volatility_filter', volatilityOk, 10, Number.isFinite(marketContext.atrPct) ? String(marketContext.atrPct) : 'n/a');
  if (!volatilityOk) {
    reasons.push('volatility below threshold');
  }

  if (marketContext.regime === 'DEAD') {
    blocks.push('regime_dead');
    reasons.push('dead_market_regime');
  } else if (marketContext.regime === 'UNSTABLE') {
    checks.push({ name: 'regime_filter', passed: false, score: -10, note: marketContext.regime });
    score -= 10;
    reasons.push('unstable_market_regime');
  } else {
    score += addCheck(checks, 'regime_filter', true, marketContext.regime === 'TRENDING' ? 5 : 2, marketContext.regime || 'unknown');
  }

  const isEurUsdBias = symbol === 'EURUSD'
    && sourceType === 'STRATEGY'
    && strategyName === 'bias';
  const isGbpUsdBias = symbol === 'GBPUSD'
    && sourceType === 'STRATEGY'
    && strategyName === 'bias';
  const isEurUsdBreakoutRetest = isEurUsdBias && setupType === 'breakout_retest';
  const isEurUsdTrendContinuation = isEurUsdBias && setupType === 'trend_continuation';
  const isGbpUsdTrendContinuation = isGbpUsdBias && setupType === 'trend_continuation';
  const trendAligned = marketContext.trendBias === 'HOLD' || marketContext.trendBias === direction;
  score += addCheck(checks, 'trend_alignment', trendAligned, 25, marketContext.trendBias || 'HOLD');
  if (!trendAligned && settings.requireTrendAlignment && !isEurUsdBreakoutRetest) {
    blocks.push('trend_conflict');
    reasons.push(`direction conflicts with trend (${marketContext.trendBias})`);
  }

  const emaFast = Number(indicators.emaFast);
  const emaSlow = Number(indicators.emaSlow);
  const rsi = Number(indicators.rsi);
  const emaSeparationAtr = Number(indicators.emaSeparationAtr);
  const cleanEmaAlignment = (direction === 'BUY' && emaFast > emaSlow)
    || (direction === 'SELL' && emaFast < emaSlow);
  const isEurUsdRangingBias = isEurUsdBias && marketContext.regime === 'RANGING' && !isEurUsdBreakoutRetest;
  const isEurUsdUnstableBias = isEurUsdBias && marketContext.regime === 'UNSTABLE';
  const isEurUsdOverrideRegime = isEurUsdBias && ['RANGING', 'UNSTABLE'].includes(marketContext.regime);
  const requiresEurUsdBiasHardening = isEurUsdBias;
  const requiresEurUsdH1Alignment = isEurUsdBias && !isEurUsdBreakoutRetest;
  const priceTooStretched = strategyReasons.includes('price_too_stretched');
  const priceSlightlyStretched = strategyReasons.includes('price_slightly_stretched');
  const continuationCheck = direction === 'BUY'
    ? Boolean(indicators.continuationLong)
    : direction === 'SELL'
      ? Boolean(indicators.continuationShort)
      : false;
  const structureCheck = direction === 'BUY'
    ? Boolean(indicators.longStructureOk)
    : direction === 'SELL'
      ? Boolean(indicators.shortStructureOk)
      : false;
  const pullbackOk = indicators.pullbackOk !== false;
  const newYorkStrictTrendAligned = marketContext.trendBias === direction;
  const londonMinFinalRr = Number(config.safetyControls.eurusdLondonMinFinalRr || settings.minFinalRiskReward);
  const newYorkMinFinalRr = Number(config.safetyControls.eurusdNewYorkMinFinalRr || settings.minFinalRiskReward);
  const overlapMinFinalRr = Math.max(londonMinFinalRr, settings.minFinalRiskReward);
  const stopDistance = Number(candidate.stopDistance);

  if (isEurUsdBias && !setupType) {
    checks.push({ name: 'eurusd_setup_type', passed: false, score: -100, note: 'missing' });
    score -= 100;
    blocks.push('eurusd_missing_setup_type');
    reasons.push('eurusd_missing_setup_type');
  } else if (isEurUsdBias && !isEurUsdTrendContinuation && !isEurUsdBreakoutRetest) {
    checks.push({ name: 'eurusd_setup_type', passed: false, score: -100, note: setupType });
    score -= 100;
    blocks.push('eurusd_invalid_setup_type');
    reasons.push('eurusd_invalid_setup_type');
  } else if (isEurUsdBias) {
    score += addCheck(checks, 'eurusd_setup_type', true, 8, setupType);
  }

  if (isEurUsdTrendContinuation && marketContext.regime !== 'TRENDING') {
    checks.push({ name: 'eurusd_trend_continuation_regime', passed: false, score: -100, note: marketContext.regime || 'UNKNOWN' });
    score -= 100;
    blocks.push('eurusd_trend_continuation_requires_trending');
    reasons.push('eurusd_trend_continuation_requires_trending');
  }

  if (isGbpUsdBias && !setupType) {
    checks.push({ name: 'gbpusd_setup_type', passed: false, score: -100, note: 'missing' });
    score -= 100;
    blocks.push('gbpusd_missing_setup_type');
    reasons.push('gbpusd_missing_setup_type');
  } else if (isGbpUsdBias && !isGbpUsdTrendContinuation) {
    checks.push({ name: 'gbpusd_setup_type', passed: false, score: -100, note: setupType });
    score -= 100;
    blocks.push('gbpusd_invalid_setup_type');
    reasons.push('gbpusd_invalid_setup_type');
  }

  if (isGbpUsdTrendContinuation && marketContext.regime !== 'TRENDING') {
    checks.push({ name: 'gbpusd_trend_continuation_regime', passed: false, score: -100, note: marketContext.regime || 'UNKNOWN' });
    score -= 100;
    blocks.push('gbpusd_trend_continuation_requires_trending');
    reasons.push('gbpusd_trend_continuation_requires_trending');
  }

  if (isGbpUsdBias && ['RANGING', 'UNSTABLE', 'DEAD'].includes(marketContext.regime)) {
    checks.push({ name: 'gbpusd_regime_gate', passed: false, score: -100, note: marketContext.regime });
    score -= 100;
    blocks.push('gbpusd_regime_block');
    reasons.push(`gbpusd_regime_${String(marketContext.regime).toLowerCase()}_block`);
  }

  if (isGbpUsdBias && !(Number.isFinite(stopDistance) && stopDistance > 0)) {
    checks.push({ name: 'gbpusd_stop_distance_required', passed: false, score: -100, note: String(candidate.stopDistance ?? 'na') });
    score -= 100;
    blocks.push('gbpusd_missing_stop_distance');
    reasons.push('gbpusd_missing_stop_distance');
  }

  if (isGbpUsdBias && (priceTooStretched || priceSlightlyStretched)) {
    checks.push({
      name: 'gbpusd_price_stretch',
      passed: false,
      score: -35,
      note: priceTooStretched ? 'price_too_stretched' : 'price_slightly_stretched',
    });
    score -= 35;
    blocks.push('gbpusd_price_stretch_block');
    reasons.push('gbpusd_price_stretch_block');
  }

  const rrTp1Ok = rrTp1 == null || rrTp1 >= settings.minTp1RiskReward;
  score += addCheck(checks, 'rr_tp1', rrTp1Ok, 8, rrTp1 == null ? 'n/a' : rrTp1.toFixed(2));
  if (!rrTp1Ok) {
    blocks.push('poor_rr_tp1');
    reasons.push('poor_rr_tp1');
  }

  const rrFinalOk = rrFinal == null || rrFinal >= settings.minFinalRiskReward;
  score += addCheck(checks, 'rr_final', rrFinalOk, 10, rrFinal == null ? 'n/a' : rrFinal.toFixed(2));
  if (!rrFinalOk) {
    blocks.push('poor_rr_final');
    reasons.push(`final rr ${rrFinal.toFixed(2)} below ${settings.minFinalRiskReward}`);
  }

  if (isEurUsdBias && (rrTp1 == null || rrFinal == null)) {
    checks.push({ name: 'eurusd_rr_required', passed: false, score: -100, note: `rrTp1=${rrTp1 ?? 'na'} rrFinal=${rrFinal ?? 'na'}` });
    score -= 100;
    blocks.push('eurusd_missing_rr');
    reasons.push('eurusd_missing_rr');
  }

  if (isEurUsdRangingBias && !config.safetyControls.eurusdBiasAllowRanging) {
    checks.push({ name: 'eurusd_bias_regime_gate', passed: false, score: -100, note: 'RANGING' });
    score -= 100;
    blocks.push('eurusd_bias_ranging_block');
    reasons.push('eurusd_bias_ranging_block');
  }

  if (isEurUsdUnstableBias && !config.safetyControls.eurusdBiasAllowUnstable) {
    checks.push({ name: 'eurusd_bias_regime_gate', passed: false, score: -100, note: 'UNSTABLE' });
    score -= 100;
    blocks.push('eurusd_bias_unstable_block');
    reasons.push('eurusd_bias_unstable_block');
  }

  if (isEurUsdBreakoutRetest) {
    const breakoutConfirmed = indicators.breakoutConfirmed === true;
    const retestConfirmed = indicators.retestConfirmed === true;

    if (!config.strategy.eurusdAllowBreakoutRetest) {
      checks.push({ name: 'eurusd_breakout_retest_enabled', passed: false, score: -100, note: 'disabled' });
      score -= 100;
      blocks.push('eurusd_breakout_retest_disabled');
      reasons.push('eurusd_breakout_retest_disabled');
    }

    if (!breakoutConfirmed || !retestConfirmed) {
      checks.push({
        name: 'eurusd_breakout_retest_confirmation',
        passed: false,
        score: -100,
        note: `breakout=${breakoutConfirmed} retest=${retestConfirmed}`,
      });
      score -= 100;
      blocks.push('eurusd_breakout_retest_not_confirmed');
      reasons.push('eurusd_breakout_retest_not_confirmed');
    } else {
      score += addCheck(checks, 'eurusd_breakout_retest_confirmation', true, 15, indicators.breakoutLevel || 'confirmed');
    }
  }

  if (isEurUsdBias && sessionBucket === 'ASIA') {
    checks.push({ name: 'eurusd_bias_session_gate', passed: false, score: -100, note: sessionBucket });
    score -= 100;
    blocks.push('eurusd_asia_session_block');
    reasons.push('eurusd_asia_session_block');
  }

  if (isEurUsdBias && sessionBucket === 'LATE_NEWYORK' && !config.safetyControls.eurusdBiasAllowLateNewYork) {
    checks.push({ name: 'eurusd_bias_session_gate', passed: false, score: -100, note: sessionBucket });
    score -= 100;
    blocks.push('eurusd_late_newyork_block');
    reasons.push('eurusd_late_newyork_block');
  }

  if (isGbpUsdBias && sessionBucket === 'ASIA') {
    checks.push({ name: 'gbpusd_session_gate', passed: false, score: -100, note: sessionBucket });
    score -= 100;
    blocks.push('gbpusd_asia_session_block');
    reasons.push('gbpusd_asia_session_block');
  }

  if (isGbpUsdBias && sessionBucket === 'LATE_NEWYORK') {
    checks.push({ name: 'gbpusd_session_gate', passed: false, score: -100, note: sessionBucket });
    score -= 100;
    blocks.push('gbpusd_late_newyork_block');
    reasons.push('gbpusd_late_newyork_block');
  }

  if (isEurUsdBias && sessionBucket === 'LONDON') {
    if (!isEurUsdBreakoutRetest && (marketContext.regime !== 'TRENDING' || !trendAligned || rrFinal == null || rrFinal < londonMinFinalRr)) {
      checks.push({ name: 'eurusd_london_session_profile', passed: false, score: -30, note: sessionBucket });
      score -= 30;
      blocks.push('eurusd_london_requires_trending_bias');
      reasons.push('eurusd_london_requires_trending_bias');
    } else if (isEurUsdBreakoutRetest && (rrFinal == null || rrFinal < londonMinFinalRr)) {
      checks.push({ name: 'eurusd_london_session_profile', passed: false, score: -30, note: sessionBucket });
      score -= 30;
      blocks.push('eurusd_london_breakout_rr_floor');
      reasons.push('eurusd_london_breakout_rr_floor');
    }
  }

  if (isEurUsdBias && ['NEWYORK', 'LATE_NEWYORK'].includes(sessionBucket)) {
    const cleanContinuationOk = continuationCheck
      && structureCheck
      && pullbackOk
      && !priceTooStretched
      && !priceSlightlyStretched
      && !(recentFailedZone && recentFailedZone.active);
    const newYorkRrOk = rrFinal != null && rrFinal >= newYorkMinFinalRr;

    if (!isEurUsdBreakoutRetest && (marketContext.regime !== 'TRENDING' || !newYorkStrictTrendAligned || !newYorkRrOk || !cleanContinuationOk)) {
      checks.push({ name: 'eurusd_newyork_session_profile', passed: false, score: -35, note: sessionBucket });
      score -= 35;
      blocks.push('eurusd_newyork_requires_clean_continuation');
      reasons.push('eurusd_newyork_requires_clean_continuation');
    } else if (isEurUsdBreakoutRetest && !newYorkRrOk) {
      checks.push({ name: 'eurusd_newyork_session_profile', passed: false, score: -35, note: sessionBucket });
      score -= 35;
      blocks.push('eurusd_newyork_breakout_rr_floor');
      reasons.push('eurusd_newyork_breakout_rr_floor');
    }
  }

  if (isGbpUsdBias && sessionBucket === 'NEWYORK') {
    const gbpNewYorkCleanTrend = marketContext.regime === 'TRENDING'
      && newYorkStrictTrendAligned
      && continuationCheck
      && structureCheck
      && pullbackOk
      && cleanEmaAlignment
      && !priceTooStretched
      && !priceSlightlyStretched;

    if (!gbpNewYorkCleanTrend) {
      checks.push({ name: 'gbpusd_newyork_session_profile', passed: false, score: -35, note: sessionBucket });
      score -= 35;
      blocks.push('gbpusd_newyork_requires_clean_trend');
      reasons.push('gbpusd_newyork_requires_clean_trend');
    }
  }

  if (requiresEurUsdH1Alignment && !h1BiasAligned) {
    checks.push({ name: 'h1_bias_alignment', passed: false, score: -25, note: h1BiasDirection || 'HOLD' });
    score -= 25;
    blocks.push('weak_h1_bias');
    reasons.push('weak_h1_bias');
  } else if (requiresEurUsdH1Alignment) {
    score += addCheck(checks, 'h1_bias_alignment', true, 12, h1BiasDirection || direction);
  }

  if (isGbpUsdBias && !h1BiasAligned) {
    checks.push({ name: 'gbpusd_h1_bias_alignment', passed: false, score: -30, note: h1BiasDirection || 'HOLD' });
    score -= 30;
    blocks.push('gbpusd_weak_h1_bias');
    reasons.push('gbpusd_weak_h1_bias');
  }

  if (requiresEurUsdBiasHardening && !triggerConfirmed) {
    checks.push({ name: 'trigger_candle', passed: false, score: -20, note: 'missing_trigger_candle' });
    score -= 20;
    blocks.push('missing_trigger_candle');
    reasons.push('missing_trigger_candle');
  } else if (requiresEurUsdBiasHardening) {
    score += addCheck(
      checks,
      'trigger_candle',
      true,
      10,
      direction === 'BUY' ? 'long_confirmed' : 'short_confirmed',
    );
  }

  if (isGbpUsdBias && !triggerConfirmed) {
    checks.push({ name: 'gbpusd_trigger_candle', passed: false, score: -30, note: 'missing_trigger_candle' });
    score -= 30;
    blocks.push('gbpusd_missing_trigger_candle');
    reasons.push('gbpusd_missing_trigger_candle');
  }

  if (requiresEurUsdBiasHardening && recentFailedZone && recentFailedZone.active) {
    checks.push({
      name: 'recent_failed_zone',
      passed: false,
      score: -45,
      note: `${recentFailedZone.priceZone || 'na'}:${recentFailedZone.cooldownEndsAt || 'na'}`,
    });
    score -= 45;
    blocks.push('recent_failed_zone_block');
    reasons.push('recent_failed_zone_block');
  }

  if (requiresEurUsdBiasHardening && sameThesisAttemptCount > 0) {
    const thesisPenalty = Math.min(30, 12 + (sameThesisAttemptCount * 6));
    checks.push({
      name: 'same_thesis_retry_penalty',
      passed: false,
      score: -thesisPenalty,
      note: `${sameThesisAttemptCount} recent attempt(s)`,
    });
    score -= thesisPenalty;

    if (isEurUsdOverrideRegime || isEurUsdBreakoutRetest) {
      blocks.push('same_thesis_retry_block');
      reasons.push('same_thesis_retry_block');
    }
  }

  if (sourceType === 'TELEGRAM') {
    const structuredSignalOk = !settings.requireStructuredSignal
      || (Number.isFinite(Number(candidate.stopLoss)) && (!settings.requireTakeProfit || (Array.isArray(candidate.takeProfits) && candidate.takeProfits.length > 0)));
    score += addCheck(checks, 'signal_structure', structuredSignalOk, 10, structuredSignalOk ? 'ok' : 'missing sl/tp');
    if (!structuredSignalOk) {
      blocks.push('malformed_signal');
      reasons.push('signal missing stop loss or take profit');
    }

    const ageOk = !Number.isFinite(signalAgeMinutes) || signalAgeMinutes <= settings.maxSignalAgeMinutes;
    score += addCheck(checks, 'signal_age', ageOk, 10, Number.isFinite(signalAgeMinutes) ? `${signalAgeMinutes}m` : 'n/a');
    if (!ageOk) {
      blocks.push('stale_signal');
      reasons.push('signal is stale');
    }

    const entryOk = !Number.isFinite(entryDeviationPct) || entryDeviationPct <= settings.maxEntryDeviationPct;
    score += addCheck(checks, 'entry_distance', entryOk, 10, Number.isFinite(entryDeviationPct) ? String(entryDeviationPct) : 'n/a');
    if (!entryOk) {
      blocks.push('entry_too_far');
      reasons.push('live price too far from signal entry');
    }

    if (candidate.isLikelyDelayedSignal) {
      blocks.push('delayed_signal');
      reasons.push('signal marked as likely delayed');
      score -= 10;
    }

    if (!settings.allowTelegramTrigger) {
      score = Math.min(score, settings.minWatchScore);
    }
  }

  if (sourceType === 'STRATEGY' && settings.useSignalConfluence) {
    if (signalConfluence.count > 0 && signalConfluence.consensusDirection === direction) {
      score += addCheck(checks, 'signal_confluence', true, 10, `${signalConfluence.count} recent signals aligned`);
      reasons.push(`${signalConfluence.count} recent Telegram signal(s) aligned`);
    } else if (signalConfluence.count > 0 && signalConfluence.consensusDirection && signalConfluence.consensusDirection !== direction) {
      checks.push({ name: 'signal_confluence', passed: false, score: -5, note: 'recent signals conflict' });
      score -= 5;
      reasons.push('recent Telegram signal flow conflicts with strategy');
    }
  }

  if (newsRisk && settings.blockNearNews) {
    blocks.push('news_risk');
    reasons.push('major news cooldown active');
  } else {
    score += addCheck(checks, 'news_filter', true, 10, newsRisk ? 'cooldown disabled' : 'clear');
  }

  const openTradeLimitOk = !(Number(options.currentPosition) !== 0 && Number(settings.maxOpenTrades) <= 0);
  score += addCheck(checks, 'open_trade_limit', openTradeLimitOk, 5, String(options.currentPosition ?? 0));
  if (!openTradeLimitOk) {
    blocks.push('max_open_trades');
    reasons.push('max open trades reached');
  }

  if (
    isEurUsdBias
    && sessionBucket === 'LONDON_NEWYORK_OVERLAP'
    && blocks.length === 0
    && marketContext.regime === 'TRENDING'
    && h1BiasAligned
    && triggerConfirmed
    && sessionMatch
    && spreadOk
    && (!settings.blockNearNews || !newsRisk)
    && rrFinal != null
    && rrFinal >= overlapMinFinalRr
  ) {
    score += addCheck(
      checks,
      'eurusd_overlap_quality_bonus',
      true,
      Number(config.safetyControls.eurusdOverlapScoreBonus || 5),
      sessionBucket,
    );
  }

  const normalizedScore = clamp(Math.round(score), 0, 100);
  const cappedScore = isEurUsdRangingBias
    ? Math.min(
        normalizedScore,
        Number(config.safetyControls.eurusdRangingBiasApprovalCap || Math.max(0, settings.minApproveScore - 1)),
      )
    : normalizedScore;
  const effectiveApproveScore = settings.minApproveScore;
  let decision = 'REJECT';

  const forceReject = blocks.includes('regime_dead')
    || blocks.includes('gbpusd_missing_setup_type')
    || blocks.includes('gbpusd_invalid_setup_type')
    || blocks.includes('gbpusd_trend_continuation_requires_trending')
    || blocks.includes('gbpusd_regime_block')
    || blocks.includes('gbpusd_missing_stop_distance')
    || blocks.includes('gbpusd_price_stretch_block')
    || blocks.includes('gbpusd_weak_h1_bias')
    || blocks.includes('gbpusd_missing_trigger_candle')
    || blocks.includes('gbpusd_asia_session_block')
    || blocks.includes('gbpusd_late_newyork_block')
    || blocks.includes('gbpusd_newyork_requires_clean_trend')
    || blocks.includes('eurusd_missing_setup_type')
    || blocks.includes('eurusd_invalid_setup_type')
    || blocks.includes('eurusd_trend_continuation_requires_trending')
    || blocks.includes('eurusd_missing_rr')
    || blocks.includes('eurusd_bias_ranging_block')
    || blocks.includes('eurusd_bias_unstable_block')
    || blocks.includes('eurusd_breakout_retest_disabled')
    || blocks.includes('eurusd_breakout_retest_not_confirmed')
    || blocks.includes('eurusd_asia_session_block')
    || blocks.includes('eurusd_late_newyork_block')
    || blocks.includes('eurusd_london_requires_trending_bias')
    || blocks.includes('eurusd_london_breakout_rr_floor')
    || blocks.includes('eurusd_newyork_requires_clean_continuation')
    || blocks.includes('eurusd_newyork_breakout_rr_floor')
    || blocks.includes('same_thesis_retry_block')
    || (isEurUsdOverrideRegime && blocks.length > 0);

  if (
    !forceReject &&
    blocks.length === 0
    && cappedScore >= effectiveApproveScore
    && (sourceType !== 'TELEGRAM' || settings.allowTelegramTrigger)
  ) {
    decision = 'APPROVE';
  } else if (!forceReject && cappedScore >= settings.minWatchScore) {
    decision = config.hybrid.watchDecision === 'REJECT' ? 'REJECT' : 'WATCH';
  }

  return {
    decision,
    score: cappedScore,
    checks,
    reasons,
    blocks,
    riskReward: rrFinal,
    rrTp1,
    rrFinal,
    context: {
      symbol,
      sourceType,
      settings,
      quote,
      spread: spreadMetrics,
      marketContext,
      sessionBucket,
      signalConfluence,
      newsRisk,
      entryDeviationPct,
      riskMetrics: {
        ...riskMetrics,
        rrTp1,
        rrFinal,
      },
    },
  };
}

module.exports = {
  evaluateHybridDecision,
};
