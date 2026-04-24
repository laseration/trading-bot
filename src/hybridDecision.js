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
  const sessionMatch = settings.allowedSessions.length === 0
    || sessionLabels.some((label) => settings.allowedSessions.includes(label));
  const isPreferredEurUsdSession = symbol === 'EURUSD'
    && (sessionLabels.includes('LONDON') || sessionLabels.includes('NEWYORK'));
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

  const trendAligned = marketContext.trendBias === 'HOLD' || marketContext.trendBias === direction;
  score += addCheck(checks, 'trend_alignment', trendAligned, 25, marketContext.trendBias || 'HOLD');
  if (!trendAligned && settings.requireTrendAlignment) {
    blocks.push('trend_conflict');
    reasons.push(`direction conflicts with trend (${marketContext.trendBias})`);
  }

  const emaFast = Number(indicators.emaFast);
  const emaSlow = Number(indicators.emaSlow);
  const rsi = Number(indicators.rsi);
  const emaSeparationAtr = Number(indicators.emaSeparationAtr);
  const cleanEmaAlignment = (direction === 'BUY' && emaFast > emaSlow)
    || (direction === 'SELL' && emaFast < emaSlow);
  const strongMomentumAligned = direction === 'BUY'
    ? Number.isFinite(rsi) && rsi >= (config.strategy.biasRsiLongMin + 7)
    : direction === 'SELL'
      ? Number.isFinite(rsi) && rsi <= (config.strategy.biasRsiShortMax - 7)
      : false;
  const hasSignalConfirmation = signalConfluence.count > 0 && signalConfluence.consensusDirection === direction;
  const canPromoteEurUsdSessionBias = symbol === 'EURUSD'
    && sourceType === 'STRATEGY'
    && strategyName === 'bias'
    && sessionMatch
    && isPreferredEurUsdSession
    && biasStrength === 'strong'
    && cleanEmaAlignment
    && trendAligned;
  const isEurUsdRangingBias = symbol === 'EURUSD'
    && sourceType === 'STRATEGY'
    && strategyName === 'bias'
    && marketContext.regime === 'RANGING';
  const requiresEurUsdBiasHardening = symbol === 'EURUSD'
    && sourceType === 'STRATEGY'
    && strategyName === 'bias';

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

  if (isEurUsdRangingBias) {
    checks.push({ name: 'ranging_bias_reject', passed: false, score: -40, note: marketContext.regime });
    score -= 40;
    blocks.push('ranging_regime_block');
    reasons.push('ranging_regime_block');
  }

  if (requiresEurUsdBiasHardening && !h1BiasAligned) {
    checks.push({ name: 'h1_bias_alignment', passed: false, score: -25, note: h1BiasDirection || 'HOLD' });
    score -= 25;
    blocks.push('weak_h1_bias');
    reasons.push('weak_h1_bias');
  } else if (requiresEurUsdBiasHardening) {
    score += addCheck(checks, 'h1_bias_alignment', true, 12, h1BiasDirection || direction);
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
  }

  if (marketContext.regime === 'UNSTABLE') {
    const directionalStrength = String(candidate.biasStrength || 'none').toLowerCase();
    const unstableConfirmationOk = directionalStrength === 'strong' || hasSignalConfirmation;
    score += addCheck(
      checks,
      'unstable_regime_confirmation',
      unstableConfirmationOk,
      unstableConfirmationOk ? 5 : 0,
      hasSignalConfirmation ? 'signal_confluence' : directionalStrength || 'none',
    );

    if (!unstableConfirmationOk) {
      blocks.push('regime_unstable_confirmation');
      reasons.push('unstable regime requires strong directional confirmation');
    }
  }

  if (canPromoteEurUsdSessionBias) {
    const sessionPromotionScore = marketContext.regime === 'UNSTABLE' ? 12 : 8;
    score += addCheck(
      checks,
      'eurusd_session_bias_promotion',
      true,
      sessionPromotionScore,
      `${sessionLabels.join('+') || 'none'}:${biasStrength}`,
    );
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

  const normalizedScore = clamp(Math.round(score), 0, 100);
  const cappedScore = isEurUsdRangingBias
    ? Math.min(
        normalizedScore,
        Number(config.safetyControls.eurusdRangingBiasApprovalCap || Math.max(0, settings.minApproveScore - 1)),
      )
    : normalizedScore;
  const effectiveApproveScore = canPromoteEurUsdSessionBias
    ? Math.max(settings.minWatchScore + 5, settings.minApproveScore - 7)
    : settings.minApproveScore;
  let decision = 'REJECT';

  if (
    blocks.length === 0
    && cappedScore >= effectiveApproveScore
    && (sourceType !== 'TELEGRAM' || settings.allowTelegramTrigger)
  ) {
    decision = 'APPROVE';
  } else if (cappedScore >= settings.minWatchScore) {
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
