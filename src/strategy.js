const crypto = require('crypto');
const config = require('./config');

function calculateSma(values, period, endIndex = values.length - 1) {
  if (!Array.isArray(values) || endIndex + 1 < period) {
    return null;
  }

  let sum = 0;

  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    sum += Number(values[index] || 0);
  }

  return sum / period;
}

function calculateEma(values, period, endIndex = values.length - 1) {
  if (!Array.isArray(values) || endIndex + 1 < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  let ema = calculateSma(values, period, period - 1);

  if (!Number.isFinite(ema)) {
    return null;
  }

  for (let index = period; index <= endIndex; index += 1) {
    ema = ((Number(values[index]) - ema) * multiplier) + ema;
  }

  return ema;
}

function calculateStandardDeviation(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const average = values.reduce((total, value) => total + Number(value || 0), 0) / values.length;
  const variance = values.reduce((total, value) => {
    const diff = Number(value || 0) - average;
    return total + diff * diff;
  }, 0) / values.length;

  return Math.sqrt(variance);
}

function calculateRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let index = closes.length - period; index < closes.length; index += 1) {
    const change = Number(closes[index]) - Number(closes[index - 1]);

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calculateAtr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length <= period) {
    return null;
  }

  const trueRanges = [];

  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    const high = Number(current.high);
    const low = Number(current.low);
    const prevClose = Number(previous.close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  const recent = trueRanges.slice(-period);
  return recent.reduce((total, value) => total + value, 0) / period;
}

function calculateAdx(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length <= period * 2) {
    return null;
  }

  const trs = [];
  const plusDms = [];
  const minusDms = [];

  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    const upMove = Number(current.high) - Number(previous.high);
    const downMove = Number(previous.low) - Number(current.low);
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      Number(current.high) - Number(current.low),
      Math.abs(Number(current.high) - Number(previous.close)),
      Math.abs(Number(current.low) - Number(previous.close)),
    );

    trs.push(tr);
    plusDms.push(plusDm);
    minusDms.push(minusDm);
  }

  if (trs.length < period * 2) {
    return null;
  }

  const dxs = [];

  for (let index = period - 1; index < trs.length; index += 1) {
    const trSum = trs.slice(index - period + 1, index + 1).reduce((total, value) => total + value, 0);
    const plusDmSum = plusDms.slice(index - period + 1, index + 1).reduce((total, value) => total + value, 0);
    const minusDmSum = minusDms.slice(index - period + 1, index + 1).reduce((total, value) => total + value, 0);

    if (trSum <= 0) {
      continue;
    }

    const plusDi = (plusDmSum / trSum) * 100;
    const minusDi = (minusDmSum / trSum) * 100;
    const denominator = plusDi + minusDi;

    if (denominator <= 0) {
      continue;
    }

    dxs.push((Math.abs(plusDi - minusDi) / denominator) * 100);
  }

  if (dxs.length < period) {
    return null;
  }

  const recent = dxs.slice(-period);
  return recent.reduce((total, value) => total + value, 0) / period;
}

function isWithinSession(timestamp, options = {}) {
  const resolvedTimestampMs = Number.isFinite(Number(options.currentTimeMs))
    ? Number(options.currentTimeMs)
    : (Number(timestamp) * 1000 || Date.now());
  const date = new Date(resolvedTimestampMs);
  const hour = date.getUTCHours();
  return hour >= config.strategy.sessionStartHourUtc && hour < config.strategy.sessionEndHourUtc;
}

function getSessionLabels(timestamp, options = {}) {
  const resolvedTimestampMs = Number.isFinite(Number(options.currentTimeMs))
    ? Number(options.currentTimeMs)
    : (Number(timestamp) * 1000 || Date.now());
  const hour = new Date(resolvedTimestampMs).getUTCHours();
  const labels = [];

  if (hour >= 6 && hour < 16) {
    labels.push('LONDON');
  }

  if (hour >= 12 && hour < 21) {
    labels.push('NEWYORK');
  }

  if (labels.length === 0) {
    labels.push('ASIA');
  }

  return labels;
}

function getPricePrecision(entry) {
  return Number(entry) >= 100 ? 2 : Number(entry) >= 1 ? 5 : 6;
}

function normalizePriceValue(value, precision) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(precision)) : null;
}

function deriveTargets(entry, direction, atr) {
  const stopDistance = atr * config.strategy.atrStopMultiplier;
  const takeProfitDistance = atr * config.strategy.atrTakeProfitMultiplier;
  const signed = direction === 'BUY' ? 1 : -1;
  const precision = getPricePrecision(entry);

  return {
    stopLoss: Number((entry - signed * stopDistance).toFixed(precision)),
    takeProfits: [
      Number((entry + signed * takeProfitDistance * 0.5).toFixed(precision)),
      Number((entry + signed * takeProfitDistance * 0.8).toFixed(precision)),
      Number((entry + signed * takeProfitDistance).toFixed(precision)),
    ],
    stopDistance,
  };
}

function calculateRiskMetrics(direction, entry, stopLoss, takeProfits = [], options = {}) {
  const normalizedDirection = String(direction || '').toUpperCase();
  const entryPrice = Number(entry);
  const stop = Number(stopLoss);
  const spread = Number(options.spread);
  const precision = getPricePrecision(entryPrice);
  const validTakeProfits = Array.isArray(takeProfits)
    ? takeProfits.map((value) => Number(value)).filter(Number.isFinite)
    : [];

  if (
    !['BUY', 'SELL'].includes(normalizedDirection)
    || !(Number.isFinite(entryPrice) && Number.isFinite(stop))
    || validTakeProfits.length === 0
  ) {
    return {
      rrTp1: null,
      rrFinal: null,
      riskDistance: null,
      rewardToTp1: null,
      rewardToFinal: null,
      effectiveEntry: null,
    };
  }

  const signedSpread = Number.isFinite(spread) && spread >= 0 ? spread : 0;
  const effectiveEntry = normalizedDirection === 'BUY'
    ? entryPrice + signedSpread
    : entryPrice - signedSpread;
  const firstTarget = validTakeProfits[0];
  const finalTarget = validTakeProfits[validTakeProfits.length - 1];
  const riskDistance = Math.abs(effectiveEntry - stop);
  const rewardToTp1 = normalizedDirection === 'SELL'
    ? effectiveEntry - firstTarget
    : firstTarget - effectiveEntry;
  const rewardToFinal = normalizedDirection === 'SELL'
    ? effectiveEntry - finalTarget
    : finalTarget - effectiveEntry;

  if (!(riskDistance > 0)) {
    return {
      rrTp1: null,
      rrFinal: null,
      riskDistance: null,
      rewardToTp1: null,
      rewardToFinal: null,
      effectiveEntry: normalizePriceValue(effectiveEntry, precision),
    };
  }

  return {
    rrTp1: rewardToTp1 > 0 ? Number((rewardToTp1 / riskDistance).toFixed(2)) : null,
    rrFinal: rewardToFinal > 0 ? Number((rewardToFinal / riskDistance).toFixed(2)) : null,
    riskDistance: Number(riskDistance.toFixed(precision)),
    rewardToTp1: rewardToTp1 > 0 ? Number(rewardToTp1.toFixed(precision)) : null,
    rewardToFinal: rewardToFinal > 0 ? Number(rewardToFinal.toFixed(precision)) : null,
    effectiveEntry: normalizePriceValue(effectiveEntry, precision),
  };
}

function buildSetupHash(payload = {}) {
  const serialized = JSON.stringify(payload);
  return crypto.createHash('sha1').update(serialized).digest('hex').slice(0, 16);
}

function evaluateTrendDirection(bars = []) {
  const closes = bars.map((bar) => Number(bar.close));
  const shortMa = calculateEma(closes, config.strategy.shortMa);
  const longMa = calculateEma(closes, config.strategy.longMa);

  if (!Number.isFinite(shortMa) || !Number.isFinite(longMa)) {
    return 'HOLD';
  }

  if (shortMa > longMa) {
    return 'BUY';
  }

  if (shortMa < longMa) {
    return 'SELL';
  }

  return 'HOLD';
}

function summarizeMarketContext(bars = [], options = {}) {
  if (!Array.isArray(bars) || bars.length < Math.max(config.strategy.longMa, config.strategy.atrPeriod + 5)) {
    return {
      valid: false,
      trendBias: 'HOLD',
      reason: 'insufficient_bars',
      sessionLabels: [],
    };
  }

  const closes = bars.map((bar) => Number(bar.close));
  const latestBar = bars[bars.length - 1];
  const latestClose = Number(latestBar.close);
  const emaFast = calculateEma(closes, config.strategy.shortMa);
  const emaSlow = calculateEma(closes, config.strategy.longMa);
  const rsi = calculateRsi(closes, config.strategy.rsiPeriod);
  const atr = calculateAtr(bars, config.strategy.atrPeriod);
  const adx = calculateAdx(bars, config.strategy.adxPeriod);
  const atrPct = Number.isFinite(atr) && latestClose > 0 ? atr / latestClose : null;
  const sessionLabels = getSessionLabels(latestBar.time, options);
  const sessionOpen = isWithinSession(latestBar.time, options);
  const trendBias = Number.isFinite(emaFast) && Number.isFinite(emaSlow)
    ? (emaFast > emaSlow ? 'BUY' : emaFast < emaSlow ? 'SELL' : 'HOLD')
    : 'HOLD';
  let regime = 'RANGING';

  if (Number.isFinite(atrPct) && atrPct < config.strategy.minAtrPct * 1.15) {
    regime = 'DEAD';
  } else if (Number.isFinite(atrPct) && atrPct > config.strategy.minAtrPct * 4) {
    regime = 'UNSTABLE';
  } else if (Number.isFinite(adx) && adx >= config.strategy.adxMin + 5) {
    regime = 'TRENDING';
  }

  return {
    valid: true,
    latestClose,
    emaFast,
    emaSlow,
    rsi,
    atr,
    adx,
    atrPct,
    trendBias,
    regime,
    sessionLabels,
    sessionOpen,
  };
}

function buildHoldResult(context, reasons = [], extras = {}) {
  const triggerBarTime = extras.triggerBarTime || (context && context.latestBar && context.latestBar.time) || null;
  const setupType = extras.setupType || 'hold';
  const setupHash = buildSetupHash({
    strategyName: extras.strategyName || '',
    setupType,
    regime: extras.regime || (context && context.regime) || null,
    biasDirection: extras.biasDirection || null,
    biasStrength: extras.biasStrength || 'none',
    reasons: Array.isArray(reasons) ? reasons : [],
    triggerBarTime,
  });

  return {
    signal: 'HOLD',
    reasons,
    indicators: context,
    strategyName: extras.strategyName || '',
    setupType,
    setupHash,
    triggerBarTime,
    biasDirection: extras.biasDirection || null,
    biasStrength: extras.biasStrength || 'none',
    regime: extras.regime || (context && context.regime) || null,
    validUntilBar: triggerBarTime,
    rrTp1: null,
    rrFinal: null,
  };
}

function evaluateTimeframeConfirmation(direction, confirmationBarsByTimeframe = {}) {
  const confirmations = Object.entries(confirmationBarsByTimeframe).map(([timeframe, bars]) => ({
    timeframe,
    direction: evaluateTrendDirection(bars),
  }));
  const aligned = confirmations.filter((entry) => entry.direction === direction);

  return {
    confirmations,
    alignedCount: aligned.length,
    requiredCount: Math.max(0, Number(config.strategy.minConfirmations || 0)),
    isAligned: aligned.length >= Math.max(0, Number(config.strategy.minConfirmations || 0)),
  };
}

function buildBaseContext(bars, options = {}) {
  if (!Array.isArray(bars) || bars.length < Math.max(config.strategy.longMa, config.strategy.atrPeriod + 5)) {
    return { hold: { signal: 'HOLD', reasons: ['insufficient_bars'] } };
  }

  const closes = bars.map((bar) => Number(bar.close));
  const latestBar = bars[bars.length - 1];
  const latestClose = Number(latestBar.close);
  const shortMa = calculateSma(closes, config.strategy.shortMa);
  const longMa = calculateSma(closes, config.strategy.longMa);
  const previousShortMa = calculateSma(closes, config.strategy.shortMa, closes.length - 2);
  const previousLongMa = calculateSma(closes, config.strategy.longMa, closes.length - 2);
  const rsi = calculateRsi(closes, config.strategy.rsiPeriod);
  const atr = calculateAtr(bars, config.strategy.atrPeriod);
  const adx = calculateAdx(bars, config.strategy.adxPeriod);
  const atrPct = Number.isFinite(atr) && latestClose > 0 ? atr / latestClose : null;

  if (!isWithinSession(latestBar.time, options)) {
    return { hold: buildHoldResult({ shortMa, longMa, rsi, atr, adx, atrPct }, ['session_blocked']) };
  }

  if (options.hasRecentRelevantNews) {
    return { hold: buildHoldResult({ shortMa, longMa, rsi, atr, adx, atrPct }, ['news_cooldown_blocked']) };
  }

  if (!options.ignoreAdxFilter && (!Number.isFinite(adx) || adx < config.strategy.adxMin)) {
    return { hold: buildHoldResult({ shortMa, longMa, rsi, atr, adx, atrPct }, ['trend_strength_too_low']) };
  }

  if (!Number.isFinite(atrPct) || atrPct < config.strategy.minAtrPct) {
    return { hold: buildHoldResult({ shortMa, longMa, rsi, atr, adx, atrPct }, ['volatility_invalid']) };
  }

  return {
    closes,
    latestBar,
    latestClose,
    shortMa,
    longMa,
    previousShortMa,
    previousLongMa,
    rsi,
    atr,
    adx,
    atrPct,
  };
}

function buildSetup(direction, entry, atr, indicators, extras = {}) {
  const targets = deriveTargets(entry, direction, atr);
  const riskMetrics = calculateRiskMetrics(direction, entry, targets.stopLoss, targets.takeProfits);
  const alignedTimeframes = Array.isArray(extras.alignedTimeframes) ? extras.alignedTimeframes : [];
  const confirmationText = alignedTimeframes.length > 0 ? ` | TF ${alignedTimeframes.join(', ')}` : '';
  const triggerBarTime = extras.triggerBarTime || (indicators && indicators.latestBar && indicators.latestBar.time) || null;
  const setupType = extras.setupType || extras.strategyName || config.strategy.name;
  const strategyName = extras.strategyName || config.strategy.name;
  const setupHash = buildSetupHash({
    strategyName,
    setupType,
    symbol: extras.symbol || '',
    direction,
    regime: extras.regime || indicators.regime || null,
    triggerBarTime,
    entry: normalizePriceValue(entry, getPricePrecision(entry)),
    stopLoss: targets.stopLoss,
    takeProfits: targets.takeProfits,
    biasDirection: extras.biasDirection || direction,
    biasStrength: extras.biasStrength || 'strong',
  });

  return {
    signal: direction,
    strategyName,
    strategyFamily: extras.strategyFamily || strategyName,
    setupType,
    setupHash,
    triggerBarTime,
    validUntilBar: triggerBarTime,
    direction,
    biasDirection: extras.biasDirection || direction,
    biasStrength: extras.biasStrength || 'strong',
    entry,
    stopLoss: targets.stopLoss,
    takeProfits: targets.takeProfits,
    stopDistance: targets.stopDistance,
    rrTp1: riskMetrics.rrTp1,
    rrFinal: riskMetrics.rrFinal,
    timeframe: config.strategy.timeframe,
    regime: extras.regime || indicators.regime || null,
    confidenceLabel: `${extras.confidencePrefix || `ADX ${indicators.adx.toFixed(1)} | RSI ${indicators.rsi.toFixed(1)}`}${confirmationText}`,
    indicators: {
      ...indicators,
      confirmationTimeframes: extras.confirmations || [],
      alignedTimeframes,
    },
  };
}

function analyzeBiasTriggerCandle(latestBar = {}, previousBar = {}, emaFast, atr) {
  const open = Number(latestBar.open);
  const close = Number(latestBar.close);
  const high = Number(latestBar.high);
  const low = Number(latestBar.low);
  const previousHigh = Number(previousBar.high);
  const previousLow = Number(previousBar.low);

  if (
    !(Number.isFinite(open) && Number.isFinite(close) && Number.isFinite(high) && Number.isFinite(low))
    || !(Number.isFinite(emaFast) && Number.isFinite(atr) && atr > 0)
  ) {
    return {
      touchedFastEmaZone: false,
      bullishRejection: false,
      bearishRejection: false,
      bullishContinuationClose: false,
      bearishContinuationClose: false,
      longConfirmed: false,
      shortConfirmed: false,
      bodyAtr: null,
      rangeAtr: null,
      lowerWickAtr: null,
      upperWickAtr: null,
      closeLocation: null,
    };
  }

  const body = Math.abs(close - open);
  const range = Math.abs(high - low);
  const candleHighBody = Math.max(open, close);
  const candleLowBody = Math.min(open, close);
  const lowerWick = candleLowBody - low;
  const upperWick = high - candleHighBody;
  const zoneBuffer = atr * 0.18;
  const touchedFastEmaZone = low <= emaFast + zoneBuffer && high >= emaFast - zoneBuffer;
  const closeLocation = range > 0 ? (close - low) / range : null;
  const bullishRejection = touchedFastEmaZone
    && close > open
    && lowerWick >= Math.max(body * 0.8, atr * 0.05)
    && closeLocation >= 0.55;
  const bearishRejection = touchedFastEmaZone
    && close < open
    && upperWick >= Math.max(body * 0.8, atr * 0.05)
    && closeLocation <= 0.45;
  const bullishContinuationClose = touchedFastEmaZone
    && close > open
    && Number.isFinite(previousHigh)
    && close > previousHigh
    && body / atr >= Math.max(config.strategy.biasEntryBodyAtrMin, 0.12);
  const bearishContinuationClose = touchedFastEmaZone
    && close < open
    && Number.isFinite(previousLow)
    && close < previousLow
    && body / atr >= Math.max(config.strategy.biasEntryBodyAtrMin, 0.12);

  return {
    touchedFastEmaZone,
    bullishRejection,
    bearishRejection,
    bullishContinuationClose,
    bearishContinuationClose,
    longConfirmed: bullishRejection || bullishContinuationClose,
    shortConfirmed: bearishRejection || bearishContinuationClose,
    bodyAtr: body / atr,
    rangeAtr: range / atr,
    lowerWickAtr: lowerWick / atr,
    upperWickAtr: upperWick / atr,
    closeLocation: Number.isFinite(closeLocation) ? Number(closeLocation.toFixed(2)) : null,
  };
}

function analyzeEurUsdBreakoutRetest(bars = [], atr) {
  const lookback = Math.max(5, Number(config.strategy.eurusdBreakoutLookbackBars || 20));
  const latestBar = bars[bars.length - 1] || {};
  const breakoutBar = bars[bars.length - 2] || {};
  const rangeBars = bars.slice(Math.max(0, bars.length - lookback - 2), bars.length - 2);

  const base = {
    recentRangeHigh: null,
    recentRangeLow: null,
    rangeSizeAtr: null,
    breakoutDirection: null,
    breakoutLevel: null,
    breakoutConfirmed: false,
    retestConfirmed: false,
    breakoutBodyAtr: null,
    retestDistanceAtr: null,
  };

  if (!Array.isArray(rangeBars) || rangeBars.length < lookback || !(Number.isFinite(atr) && atr > 0)) {
    return { ...base, reason: 'insufficient_breakout_range' };
  }

  const highs = rangeBars.map((bar) => Number(bar.high)).filter(Number.isFinite);
  const lows = rangeBars.map((bar) => Number(bar.low)).filter(Number.isFinite);
  const recentRangeHigh = Math.max(...highs);
  const recentRangeLow = Math.min(...lows);
  const rangeSizeAtr = (recentRangeHigh - recentRangeLow) / atr;
  const breakoutOpen = Number(breakoutBar.open);
  const breakoutClose = Number(breakoutBar.close);
  const latestOpen = Number(latestBar.open);
  const latestClose = Number(latestBar.close);
  const latestHigh = Number(latestBar.high);
  const latestLow = Number(latestBar.low);
  const breakoutBodyAtr = Number.isFinite(breakoutOpen) && Number.isFinite(breakoutClose)
    ? Math.abs(breakoutClose - breakoutOpen) / atr
    : null;
  const minRangeAtr = Number(config.strategy.eurusdBreakoutMinRangeAtr || 0.8);
  const maxRangeAtr = Number(config.strategy.eurusdBreakoutMaxRangeAtr || 3.0);
  const minBodyAtr = Number(config.strategy.eurusdBreakoutBodyAtrMin || 0.35);
  const toleranceAtr = Number(config.strategy.eurusdRetestToleranceAtr || 0.15);
  const maxStretchAtr = Number(config.strategy.eurusdBreakoutMaxStretchAtr || 0.9);

  const details = {
    ...base,
    recentRangeHigh,
    recentRangeLow,
    rangeSizeAtr: Number.isFinite(rangeSizeAtr) ? Number(rangeSizeAtr.toFixed(2)) : null,
    breakoutBodyAtr: Number.isFinite(breakoutBodyAtr) ? Number(breakoutBodyAtr.toFixed(2)) : null,
  };

  if (!(Number.isFinite(recentRangeHigh) && Number.isFinite(recentRangeLow) && Number.isFinite(rangeSizeAtr))) {
    return { ...details, reason: 'invalid_breakout_range' };
  }

  if (rangeSizeAtr < minRangeAtr || rangeSizeAtr > maxRangeAtr) {
    return { ...details, reason: 'breakout_range_invalid' };
  }

  if (!(Number.isFinite(breakoutClose) && Number.isFinite(breakoutBodyAtr) && breakoutBodyAtr >= minBodyAtr)) {
    return { ...details, reason: 'breakout_body_too_small' };
  }

  let breakoutDirection = null;
  let breakoutLevel = null;

  if (breakoutClose > recentRangeHigh) {
    breakoutDirection = 'BUY';
    breakoutLevel = recentRangeHigh;
  } else if (breakoutClose < recentRangeLow) {
    breakoutDirection = 'SELL';
    breakoutLevel = recentRangeLow;
  }

  if (!breakoutDirection) {
    return { ...details, reason: 'breakout_not_confirmed' };
  }

  const retestDistanceAtr = Number.isFinite(latestClose) && Number.isFinite(breakoutLevel)
    ? Math.abs(latestClose - breakoutLevel) / atr
    : null;
  const tolerance = atr * toleranceAtr;
  const bullishRetest = breakoutDirection === 'BUY'
    && Number.isFinite(latestLow)
    && Number.isFinite(latestOpen)
    && Number.isFinite(latestClose)
    && latestLow <= breakoutLevel + tolerance
    && latestClose >= breakoutLevel
    && latestClose > latestOpen;
  const bearishRetest = breakoutDirection === 'SELL'
    && Number.isFinite(latestHigh)
    && Number.isFinite(latestOpen)
    && Number.isFinite(latestClose)
    && latestHigh >= breakoutLevel - tolerance
    && latestClose <= breakoutLevel
    && latestClose < latestOpen;
  const retestConfirmed = bullishRetest || bearishRetest;
  const breakout = {
    ...details,
    breakoutDirection,
    breakoutLevel,
    breakoutConfirmed: true,
    retestConfirmed,
    retestDistanceAtr: Number.isFinite(retestDistanceAtr) ? Number(retestDistanceAtr.toFixed(2)) : null,
  };

  if (!retestConfirmed && Number.isFinite(retestDistanceAtr) && retestDistanceAtr > maxStretchAtr) {
    return { ...breakout, reason: 'breakout_too_stretched' };
  }

  if (!retestConfirmed) {
    return { ...breakout, reason: 'breakout_waiting_for_retest' };
  }

  return { ...breakout, reason: null };
}

function buildHigherTimeframeBiasContext(bars = [], options = {}) {
  if (!Array.isArray(bars) || bars.length < Math.max(config.strategy.longMa, config.strategy.atrPeriod + 5)) {
    return {
      valid: false,
      direction: 'HOLD',
      strength: 'none',
      aligned: false,
      regime: null,
      reason: 'insufficient_h1_bars',
    };
  }

  const summary = summarizeMarketContext(bars, options);
  const closes = bars.map((bar) => Number(bar.close));
  const latestClose = Number(summary.latestClose);
  const atr = Number(summary.atr);
  const emaFast = calculateEma(closes, config.strategy.shortMa);
  const emaSlow = calculateEma(closes, config.strategy.longMa);
  const emaSeparationAtr = Number.isFinite(atr) && atr > 0 && Number.isFinite(emaFast) && Number.isFinite(emaSlow)
    ? Math.abs(emaFast - emaSlow) / atr
    : null;
  const bullish = Number.isFinite(emaFast) && Number.isFinite(emaSlow)
    && Number.isFinite(latestClose)
    && emaFast > emaSlow
    && latestClose >= emaFast
    && Number.isFinite(emaSeparationAtr)
    && emaSeparationAtr >= 0.08
    && Number.isFinite(summary.rsi)
    && summary.rsi >= Math.max(config.strategy.biasRsiLongMin, 50);
  const bearish = Number.isFinite(emaFast) && Number.isFinite(emaSlow)
    && Number.isFinite(latestClose)
    && emaFast < emaSlow
    && latestClose <= emaFast
    && Number.isFinite(emaSeparationAtr)
    && emaSeparationAtr >= 0.08
    && Number.isFinite(summary.rsi)
    && summary.rsi <= Math.min(config.strategy.biasRsiShortMax, 50);
  const direction = bullish ? 'BUY' : bearish ? 'SELL' : 'HOLD';

  return {
    ...summary,
    valid: Boolean(summary.valid),
    timeframe: 'H1',
    emaFast,
    emaSlow,
    emaSeparationAtr,
    direction,
    strength: direction === 'HOLD'
      ? 'weak'
      : emaSeparationAtr >= 0.14
        ? 'strong'
        : 'moderate',
    aligned: direction === 'BUY' || direction === 'SELL',
    reason: direction === 'HOLD' ? 'weak_h1_bias' : null,
  };
}

function evaluateTrendStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, options);

  if (context.hold) {
    return context.hold;
  }

  const crossedUp = Number.isFinite(context.previousShortMa) && Number.isFinite(context.previousLongMa)
    && context.previousShortMa <= context.previousLongMa && context.shortMa > context.longMa;
  const crossedDown = Number.isFinite(context.previousShortMa) && Number.isFinite(context.previousLongMa)
    && context.previousShortMa >= context.previousLongMa && context.shortMa < context.longMa;

  if (crossedUp && Number.isFinite(context.rsi) && context.rsi >= config.strategy.rsiLongMin) {
    const confirmation = evaluateTimeframeConfirmation('BUY', options.confirmationBarsByTimeframe);

    if (!confirmation.isAligned) {
      return {
        signal: 'HOLD',
        reasons: ['timeframe_alignment'],
        indicators: { ...context, confirmationTimeframes: confirmation.confirmations },
      };
    }

    return buildSetup('BUY', context.latestClose, context.atr, context, {
      strategyName: 'trend',
      confirmations: confirmation.confirmations,
      alignedTimeframes: confirmation.confirmations.filter((entry) => entry.direction === 'BUY').map((entry) => entry.timeframe),
    });
  }

  if (crossedDown && Number.isFinite(context.rsi) && context.rsi <= config.strategy.rsiShortMax) {
    const confirmation = evaluateTimeframeConfirmation('SELL', options.confirmationBarsByTimeframe);

    if (!confirmation.isAligned) {
      return {
        signal: 'HOLD',
        reasons: ['timeframe_alignment'],
        indicators: { ...context, confirmationTimeframes: confirmation.confirmations },
      };
    }

    return buildSetup('SELL', context.latestClose, context.atr, context, {
      strategyName: 'trend',
      confirmations: confirmation.confirmations,
      alignedTimeframes: confirmation.confirmations.filter((entry) => entry.direction === 'SELL').map((entry) => entry.timeframe),
    });
  }

  return {
    signal: 'HOLD',
    reasons: ['no_valid_setup'],
    indicators: context,
  };
}

function formatDiagnosticNumber(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : null;
}

function buildEmaPullbackDiagnostics({
  context,
  trendDirection,
  distanceAtr,
  emaFast,
  emaSlow,
  stopDistance,
  riskMetrics,
  confirmation,
  pullbackOk,
  continuationOk,
  activeCandle,
  notOverextended,
  momentumOk,
}) {
  const session = Array.isArray(context.sessionLabels) && context.sessionLabels.length > 0
    ? context.sessionLabels.join('|')
    : 'none';
  const alignedTimeframes = confirmation.confirmations
    .filter((entry) => entry.direction === trendDirection)
    .map((entry) => entry.timeframe);

  return {
    emaDirection: trendDirection,
    trendAligned: confirmation.isAligned,
    alignedTimeframes,
    requiredTimeframes: confirmation.requiredCount,
    pullbackDistanceAtr: formatDiagnosticNumber(distanceAtr, 2),
    pullbackOk,
    continuationOk,
    activeCandle,
    notOverextended,
    rsi: formatDiagnosticNumber(context.rsi, 1),
    rsiOk: momentumOk,
    atr: formatDiagnosticNumber(context.atr, 6),
    stopDistance: formatDiagnosticNumber(stopDistance, 6),
    rrTp1: riskMetrics.rrTp1,
    rrFinal: riskMetrics.rrFinal,
    session,
    regime: context.regime || 'UNKNOWN',
    adx: formatDiagnosticNumber(context.adx, 1),
    adxOk: Number.isFinite(Number(context.adx)) && Number(context.adx) >= Number(config.strategy.adxMin || 0),
  };
}

function buildEmaPullbackHold(context, reasons, diagnostics, trendDirection) {
  return buildHoldResult(
    { ...context, emaPullback: diagnostics },
    reasons,
    {
      strategyName: 'ema_pullback',
      setupType: 'ema_pullback_hold',
      biasDirection: trendDirection === 'HOLD' ? null : trendDirection,
      biasStrength: diagnostics && diagnostics.pullbackDistanceAtr != null && diagnostics.pullbackDistanceAtr <= 0.45 ? 'moderate' : 'weak',
      regime: context.regime,
    },
  );
}

function evaluateEmaPullbackStrategy(bars, options = {}) {
  const baseContext = buildBaseContext(bars, {
    ...options,
    ignoreAdxFilter: true,
  });
  const marketSummary = summarizeMarketContext(bars, options);
  const context = baseContext.hold
    ? {
        ...(baseContext.hold.indicators || {}),
        sessionLabels: marketSummary.sessionLabels || [],
        sessionOpen: marketSummary.sessionOpen,
        regime: marketSummary.regime || null,
        adx: marketSummary.adx ?? (baseContext.hold.indicators && baseContext.hold.indicators.adx),
        atr: marketSummary.atr ?? (baseContext.hold.indicators && baseContext.hold.indicators.atr),
        rsi: marketSummary.rsi ?? (baseContext.hold.indicators && baseContext.hold.indicators.rsi),
      }
    : {
        ...baseContext,
        sessionLabels: marketSummary.sessionLabels || [],
        sessionOpen: marketSummary.sessionOpen,
        regime: marketSummary.regime || baseContext.regime || null,
      };

  if (baseContext.hold) {
    return {
      ...baseContext.hold,
      strategyName: 'ema_pullback',
      setupType: 'ema_pullback_hold',
      indicators: {
        ...context,
        emaPullback: {
          emaDirection: 'UNKNOWN',
          trendAligned: false,
          pullbackDistanceAtr: null,
          rsi: formatDiagnosticNumber(context.rsi, 1),
          atr: formatDiagnosticNumber(context.atr, 6),
          stopDistance: null,
          rrTp1: null,
          rrFinal: null,
          session: Array.isArray(context.sessionLabels) && context.sessionLabels.length > 0 ? context.sessionLabels.join('|') : 'none',
          regime: context.regime || 'UNKNOWN',
          adx: formatDiagnosticNumber(context.adx, 1),
        },
      },
    };
  }

  const closes = bars.map((bar) => Number(bar.close));
  const emaFast = calculateEma(closes, config.strategy.shortMa);
  const emaSlow = calculateEma(closes, config.strategy.longMa);
  const latestBar = context.latestBar || bars[bars.length - 1] || {};
  const previousBar = bars[bars.length - 2] || {};
  const latestClose = Number(context.latestClose);
  const previousClose = Number(previousBar.close);
  const atr = Number(context.atr);

  if (!(Number.isFinite(emaFast) && Number.isFinite(emaSlow) && Number.isFinite(latestClose) && Number.isFinite(atr) && atr > 0)) {
    const diagnostics = {
      emaDirection: 'UNKNOWN',
      trendAligned: false,
      pullbackDistanceAtr: null,
      rsi: formatDiagnosticNumber(context.rsi, 1),
      atr: formatDiagnosticNumber(context.atr, 6),
      stopDistance: null,
      rrTp1: null,
      rrFinal: null,
      session: Array.isArray(context.sessionLabels) ? context.sessionLabels.join('|') : 'none',
      regime: context.regime || 'UNKNOWN',
      adx: formatDiagnosticNumber(context.adx, 1),
    };
    return buildEmaPullbackHold(
      { ...context, emaFast, emaSlow },
      ['insufficient_ema_pullback_data'],
      diagnostics,
      'HOLD',
    );
  }

  const trendDirection = emaFast > emaSlow ? 'BUY' : emaFast < emaSlow ? 'SELL' : 'HOLD';
  const distanceAtr = Math.abs(latestClose - emaFast) / atr;
  const pullbackWindow = bars.slice(Math.max(0, bars.length - 5));
  const touchedFastFromAbove = pullbackWindow.some((bar) => Number(bar.low) <= emaFast + atr * 0.2);
  const touchedFastFromBelow = pullbackWindow.some((bar) => Number(bar.high) >= emaFast - atr * 0.2);
  const continuationBodyAtr = Number.isFinite(Number(latestBar.open))
    ? Math.abs(latestClose - Number(latestBar.open)) / atr
    : 0;
  const activeCandle = continuationBodyAtr >= Math.max(0.12, Number(config.strategy.biasEntryBodyAtrMin || 0.12));
  const notOverextended = distanceAtr <= 0.75;
  const confirmation = evaluateTimeframeConfirmation(trendDirection, options.confirmationBarsByTimeframe);
  const targets = trendDirection === 'BUY' || trendDirection === 'SELL'
    ? deriveTargets(latestClose, trendDirection, atr)
    : { stopDistance: null, stopLoss: null, takeProfits: [] };
  const riskMetrics = trendDirection === 'BUY' || trendDirection === 'SELL'
    ? calculateRiskMetrics(trendDirection, latestClose, targets.stopLoss, targets.takeProfits)
    : { rrTp1: null, rrFinal: null };
  const momentumOk = trendDirection === 'BUY'
    ? Number.isFinite(context.rsi) && context.rsi >= Math.max(45, Number(config.strategy.rsiLongMin || 40)) && context.rsi <= 72
    : trendDirection === 'SELL'
      ? Number.isFinite(context.rsi) && context.rsi <= Math.min(55, Number(config.strategy.rsiShortMax || 60)) && context.rsi >= 28
      : false;
  const adxOk = Number.isFinite(Number(context.adx)) && Number(context.adx) >= Number(config.strategy.adxMin || 0);
  const pullbackOk = trendDirection === 'BUY'
    ? touchedFastFromAbove || distanceAtr <= 0.4
    : trendDirection === 'SELL'
      ? touchedFastFromBelow || distanceAtr <= 0.4
      : false;
  const continuationOk = trendDirection === 'BUY'
    ? latestClose >= emaFast - atr * 0.1 && (!Number.isFinite(previousClose) || latestClose >= previousClose)
    : trendDirection === 'SELL'
      ? latestClose <= emaFast + atr * 0.1 && (!Number.isFinite(previousClose) || latestClose <= previousClose)
      : false;
  const diagnostics = buildEmaPullbackDiagnostics({
    context,
    trendDirection,
    distanceAtr,
    emaFast,
    emaSlow,
    stopDistance: targets.stopDistance,
    riskMetrics,
    confirmation,
    pullbackOk,
    continuationOk,
    activeCandle,
    notOverextended,
    momentumOk,
  });
  const indicators = {
    ...context,
    emaFast,
    emaSlow,
    trendDirection,
    distanceAtr,
    touchedFastFromAbove,
    touchedFastFromBelow,
    continuationBodyAtr,
    confirmationTimeframes: confirmation.confirmations,
    emaPullback: diagnostics,
  };

  if (
    (trendDirection === 'BUY' || trendDirection === 'SELL')
    && momentumOk
    && pullbackOk
    && continuationOk
    && notOverextended
    && activeCandle
    && adxOk
    && confirmation.isAligned
  ) {
    return buildSetup(trendDirection, latestClose, atr, indicators, {
      strategyName: 'ema_pullback',
      setupType: 'ema_pullback',
      biasDirection: trendDirection,
      biasStrength: distanceAtr <= 0.4 ? 'strong' : 'moderate',
      regime: context.regime,
      confidencePrefix: `EMA Pullback | dir=${trendDirection} | pullback=${distanceAtr.toFixed(2)}ATR | RSI ${context.rsi.toFixed(1)} | ATR ${atr.toFixed(6)} | RR ${riskMetrics.rrFinal ?? 'na'} | session ${diagnostics.session} | regime ${diagnostics.regime}`,
      confirmations: confirmation.confirmations,
      alignedTimeframes: diagnostics.alignedTimeframes,
    });
  }

  const reasons = [];

  if (trendDirection === 'HOLD') reasons.push('ema_trend_flat');
  if (!adxOk) reasons.push('trend_strength_too_low');
  if (!confirmation.isAligned) reasons.push('timeframe_alignment');
  if (!pullbackOk) reasons.push('pullback_not_in_zone');
  if (!continuationOk) reasons.push('continuation_not_confirmed');
  if (!momentumOk) reasons.push('rsi_not_confirmed');
  if (!notOverextended) reasons.push('price_too_extended');
  if (!activeCandle) reasons.push('trigger_candle_too_small');
  if (reasons.length === 0) reasons.push('ema_pullback_not_confirmed');

  return buildEmaPullbackHold(indicators, reasons, diagnostics, trendDirection);
}

function evaluateBreakoutStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, options);

  if (context.hold) {
    return context.hold;
  }

  const lookback = Math.max(5, Number(config.strategy.breakoutLookback || 20));
  const recent = bars.slice(-(lookback + 1), -1);
  const breakoutHigh = Math.max(...recent.map((bar) => Number(bar.high)));
  const breakoutLow = Math.min(...recent.map((bar) => Number(bar.low)));

  if (context.latestClose > breakoutHigh && Number.isFinite(context.rsi) && context.rsi >= Math.max(config.strategy.rsiLongMin, 55)) {
    const confirmation = evaluateTimeframeConfirmation('BUY', options.confirmationBarsByTimeframe);

    if (!confirmation.isAligned) {
      return {
        signal: 'HOLD',
        reasons: ['timeframe_alignment'],
        indicators: { ...context, breakoutHigh, breakoutLow, confirmationTimeframes: confirmation.confirmations },
      };
    }

    return buildSetup('BUY', context.latestClose, context.atr, { ...context, breakoutHigh, breakoutLow }, {
      strategyName: 'breakout',
      confidencePrefix: `Breakout | ADX ${context.adx.toFixed(1)} | RSI ${context.rsi.toFixed(1)}`,
      confirmations: confirmation.confirmations,
      alignedTimeframes: confirmation.confirmations.filter((entry) => entry.direction === 'BUY').map((entry) => entry.timeframe),
    });
  }

  if (context.latestClose < breakoutLow && Number.isFinite(context.rsi) && context.rsi <= Math.min(config.strategy.rsiShortMax, 45)) {
    const confirmation = evaluateTimeframeConfirmation('SELL', options.confirmationBarsByTimeframe);

    if (!confirmation.isAligned) {
      return {
        signal: 'HOLD',
        reasons: ['timeframe_alignment'],
        indicators: { ...context, breakoutHigh, breakoutLow, confirmationTimeframes: confirmation.confirmations },
      };
    }

    return buildSetup('SELL', context.latestClose, context.atr, { ...context, breakoutHigh, breakoutLow }, {
      strategyName: 'breakout',
      confidencePrefix: `Breakout | ADX ${context.adx.toFixed(1)} | RSI ${context.rsi.toFixed(1)}`,
      confirmations: confirmation.confirmations,
      alignedTimeframes: confirmation.confirmations.filter((entry) => entry.direction === 'SELL').map((entry) => entry.timeframe),
    });
  }

  return {
    signal: 'HOLD',
    reasons: ['breakout_not_confirmed'],
    indicators: { ...context, breakoutHigh, breakoutLow },
  };
}

function evaluateBiasStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, {
    ...options,
    ignoreAdxFilter: true,
  });

  if (context.hold) {
    return context.hold;
  }

  const closes = bars.map((bar) => Number(bar.close));
  const emaFast = calculateEma(closes, config.strategy.shortMa);
  const emaSlow = calculateEma(closes, config.strategy.longMa);
  const latestClose = Number(context.latestClose);
  const atr = Number(context.atr);
  const higherTimeframeBars = options.confirmationBarsByTimeframe && options.confirmationBarsByTimeframe.H1;
  const h1Bias = buildHigherTimeframeBiasContext(higherTimeframeBars, options);

  if (!(Number.isFinite(emaFast) && Number.isFinite(emaSlow) && Number.isFinite(latestClose) && Number.isFinite(atr) && atr > 0)) {
    return {
      signal: 'HOLD',
      reasons: ['insufficient_bias_data'],
      indicators: context,
    };
  }

  const distanceFromFast = Math.abs(latestClose - emaFast);
  const latestBar = context.latestBar || bars[bars.length - 1] || {};
  const previousBar = bars[bars.length - 2] || {};
  const regime = context.regime || 'RANGING';
  const isEurUsdBias = String(options.symbol || '').toUpperCase() === 'EURUSD';
  // Allow slightly more room for continuation pullbacks without moving the
  // hard overextension cutoff.
  const genericPullbackExtraAllowance = regime === 'TRENDING' ? 0.32 : 0.18;
  const pullbackAllowance = isEurUsdBias && regime === 'RANGING'
    ? config.strategy.biasPullbackAtrMultiplier + Number(config.strategy.eurusdBiasRangingPullbackAtrExtraAllowance || 0.08)
    : config.strategy.biasPullbackAtrMultiplier + genericPullbackExtraAllowance;
  const stretchAllowance = config.strategy.biasPullbackAtrMultiplier + (regime === 'TRENDING' ? 0.5 : 0.35);
  const distanceAtr = distanceFromFast / atr;
  const pullbackOk = distanceFromFast <= atr * pullbackAllowance;
  const mildlyStretched = distanceFromFast <= atr * stretchAllowance;
  const trendBuffer = atr * config.strategy.biasTrendBufferAtrMultiplier;
  const emaSeparationAtr = Math.abs(emaFast - emaSlow) / atr;
  const previousEmaFast = calculateEma(closes, config.strategy.shortMa, closes.length - 2);
  const latestBodyAtr = Number.isFinite(Number(latestBar.open))
    ? Math.abs(latestClose - Number(latestBar.open)) / atr
    : 0;
  const latestRangeAtr = Number.isFinite(Number(latestBar.high)) && Number.isFinite(Number(latestBar.low))
    ? Math.abs(Number(latestBar.high) - Number(latestBar.low)) / atr
    : 0;
  const emaVelocityAtr = Number.isFinite(previousEmaFast) ? Math.abs(emaFast - previousEmaFast) / atr : 0;
  const momentumLongOk = Number.isFinite(context.rsi) && context.rsi >= config.strategy.biasRsiLongMin;
  const momentumShortOk = Number.isFinite(context.rsi) && context.rsi <= config.strategy.biasRsiShortMax;
  const longStructureOk = emaFast > emaSlow && latestClose >= (emaFast - trendBuffer);
  const shortStructureOk = emaFast < emaSlow && latestClose <= (emaFast + trendBuffer);
  const recentCloseUp = Number.isFinite(Number(previousBar.close)) && latestClose > Number(previousBar.close);
  const recentCloseDown = Number.isFinite(Number(previousBar.close)) && latestClose < Number(previousBar.close);
  const continuationLong = (latestClose - emaFast) / atr >= config.strategy.biasEntryContinuationAtrMin && recentCloseUp;
  const continuationShort = (emaFast - latestClose) / atr >= config.strategy.biasEntryContinuationAtrMin && recentCloseDown;
  const activeBody = latestBodyAtr >= config.strategy.biasEntryBodyAtrMin;
  const activeRange = latestRangeAtr >= config.strategy.biasEntryRangeAtrMin;
  const activeVelocity = emaVelocityAtr >= config.strategy.biasEntryEmaVelocityAtrMin;
  const triggerCandle = analyzeBiasTriggerCandle(latestBar, previousBar, emaFast, atr);
  const eurUsdRangingMinEmaSeparationAtr = Number(config.strategy.eurusdBiasRangingMinEmaSeparationAtr || 0.12);
  const eurUsdRangingRsiBuffer = Number(config.strategy.eurusdBiasRangingRsiBuffer || 5);
  const cleanLongAlignment = emaFast > emaSlow && latestClose >= emaFast;
  const cleanShortAlignment = emaFast < emaSlow && latestClose <= emaFast;
  const eurUsdRangingLongOk = String(options.symbol || '').toUpperCase() === 'EURUSD'
    && regime === 'RANGING'
    && cleanLongAlignment
    && Number.isFinite(emaSeparationAtr)
    && emaSeparationAtr >= eurUsdRangingMinEmaSeparationAtr
    && Number.isFinite(context.rsi)
    && context.rsi >= config.strategy.biasRsiLongMin + eurUsdRangingRsiBuffer
    && continuationLong
    && activeBody
    && activeRange;
  const eurUsdRangingShortOk = String(options.symbol || '').toUpperCase() === 'EURUSD'
    && regime === 'RANGING'
    && cleanShortAlignment
    && Number.isFinite(emaSeparationAtr)
    && emaSeparationAtr >= eurUsdRangingMinEmaSeparationAtr
    && Number.isFinite(context.rsi)
    && context.rsi <= config.strategy.biasRsiShortMax - eurUsdRangingRsiBuffer
    && continuationShort
    && activeBody
    && activeRange;
  const eurUsdEntryConfirmation = String(options.symbol || '').toUpperCase() === 'EURUSD'
    ? {
        longOk: triggerCandle.longConfirmed && (activeBody || activeVelocity || activeRange) && (regime === 'RANGING' ? eurUsdRangingLongOk : true),
        shortOk: triggerCandle.shortConfirmed && (activeBody || activeVelocity || activeRange) && (regime === 'RANGING' ? eurUsdRangingShortOk : true),
      }
    : { longOk: true, shortOk: true };
  const biasDiagnostics = {
    emaFast,
    emaSlow,
    distanceFromFast,
    distanceAtr,
    emaSeparationAtr,
    latestBodyAtr,
    latestRangeAtr,
    emaVelocityAtr,
    pullbackOk,
    mildlyStretched,
    longStructureOk,
    shortStructureOk,
    continuationLong,
    continuationShort,
    activeBody,
    activeRange,
    activeVelocity,
    triggerCandle,
    h1Bias,
    eurUsdEntryConfirmation,
  };
  const eurUsdBreakout = isEurUsdBias ? analyzeEurUsdBreakoutRetest(bars, atr) : null;
  const breakoutDiagnostics = eurUsdBreakout ? {
    recentRangeHigh: eurUsdBreakout.recentRangeHigh,
    recentRangeLow: eurUsdBreakout.recentRangeLow,
    rangeSizeAtr: eurUsdBreakout.rangeSizeAtr,
    breakoutDirection: eurUsdBreakout.breakoutDirection,
    breakoutLevel: eurUsdBreakout.breakoutLevel,
    breakoutConfirmed: eurUsdBreakout.breakoutConfirmed,
    retestConfirmed: eurUsdBreakout.retestConfirmed,
    breakoutBodyAtr: eurUsdBreakout.breakoutBodyAtr,
    retestDistanceAtr: eurUsdBreakout.retestDistanceAtr,
  } : {};

  if (isEurUsdBias
    && config.strategy.eurusdAllowBreakoutRetest
    && eurUsdBreakout
    && eurUsdBreakout.breakoutConfirmed
  ) {
    if (!eurUsdBreakout.retestConfirmed) {
      return buildHoldResult(
        { ...context, ...biasDiagnostics, ...breakoutDiagnostics },
        [eurUsdBreakout.reason || 'breakout_waiting_for_retest'],
        {
          strategyName: 'bias',
          setupType: 'hold',
          biasDirection: eurUsdBreakout.breakoutDirection,
          biasStrength: 'moderate',
          regime,
        },
      );
    }

    const breakoutDirection = eurUsdBreakout.breakoutDirection;
    const breakoutTriggerCandle = {
      ...triggerCandle,
      longConfirmed: breakoutDirection === 'BUY',
      shortConfirmed: breakoutDirection === 'SELL',
      breakoutRetest: true,
    };
    const breakoutSetup = buildSetup(
      breakoutDirection,
      latestClose,
      atr,
      { ...context, ...biasDiagnostics, ...breakoutDiagnostics, triggerCandle: breakoutTriggerCandle },
      {
        strategyName: 'bias',
        setupType: 'breakout_retest',
        biasStrength: 'strong',
        biasDirection: breakoutDirection,
        regime,
        confidencePrefix: `EURUSD Breakout Retest | Range ${eurUsdBreakout.rangeSizeAtr}ATR | Retest ${eurUsdBreakout.retestDistanceAtr}ATR`,
      },
    );

    if (breakoutSetup.rrTp1 != null && breakoutSetup.rrFinal != null) {
      return breakoutSetup;
    }

    return buildHoldResult(
      { ...context, ...biasDiagnostics, ...breakoutDiagnostics },
      ['invalid_breakout_retest_rr'],
      {
        strategyName: 'bias',
        setupType: 'hold',
        biasDirection: breakoutDirection,
        biasStrength: 'weak',
        regime,
      },
    );
  }

  if (isEurUsdBias && regime === 'RANGING') {
    return buildHoldResult(
      { ...context, ...biasDiagnostics, ...breakoutDiagnostics },
      ['eurusd_ranging_blocked'],
      {
        strategyName: 'bias',
        setupType: 'hold',
        biasDirection: h1Bias.direction === 'HOLD' ? null : h1Bias.direction,
        biasStrength: h1Bias.strength || 'weak',
        regime,
      },
    );
  }

  const longH1Aligned = !isEurUsdBias || h1Bias.direction === 'BUY';
  const shortH1Aligned = !isEurUsdBias || h1Bias.direction === 'SELL';

  if (isEurUsdBias && (!h1Bias.valid || h1Bias.direction === 'HOLD')) {
    return buildHoldResult(
      { ...context, ...biasDiagnostics, ...breakoutDiagnostics },
      ['weak_h1_bias'],
      {
        strategyName: 'bias',
        setupType: 'hold',
        biasDirection: null,
        biasStrength: 'weak',
        regime,
      },
    );
  }

  const trendContinuationRegimeOk = !isEurUsdBias || regime === 'TRENDING';

  if (trendContinuationRegimeOk && longStructureOk && pullbackOk && momentumLongOk && longH1Aligned && eurUsdEntryConfirmation.longOk) {
    return buildSetup('BUY', latestClose, atr, { ...context, ...biasDiagnostics }, {
      strategyName: 'bias',
      setupType: isEurUsdBias ? 'trend_continuation' : undefined,
      biasStrength: 'strong',
      biasDirection: 'BUY',
      regime,
      confidencePrefix: `EMA Bias | Pullback ${distanceAtr.toFixed(2)}R | RSI ${context.rsi.toFixed(1)}`,
    });
  }

  if (trendContinuationRegimeOk && shortStructureOk && pullbackOk && momentumShortOk && shortH1Aligned && eurUsdEntryConfirmation.shortOk) {
    return buildSetup('SELL', latestClose, atr, { ...context, ...biasDiagnostics }, {
      strategyName: 'bias',
      setupType: isEurUsdBias ? 'trend_continuation' : undefined,
      biasStrength: 'strong',
      biasDirection: 'SELL',
      regime,
      confidencePrefix: `EMA Bias | Pullback ${distanceAtr.toFixed(2)}R | RSI ${context.rsi.toFixed(1)}`,
    });
  }

  const bullishBias = emaFast > emaSlow;
  const bearishBias = emaFast < emaSlow;
  const biasDirection = bullishBias ? 'BUY' : bearishBias ? 'SELL' : null;
  const reasons = [];
  const opposingStructure = bullishBias
    ? latestClose < (emaFast - trendBuffer * 1.75)
    : bearishBias
      ? latestClose > (emaFast + trendBuffer * 1.75)
      : false;
  const opposingMomentum = bullishBias
    ? Number.isFinite(context.rsi) && context.rsi <= config.strategy.biasRsiShortMax
    : bearishBias
      ? Number.isFinite(context.rsi) && context.rsi >= config.strategy.biasRsiLongMin
      : false;
  const deadOrFlat = regime === 'DEAD' || emaSeparationAtr < 0.04;
  const conflictingBias = Boolean(biasDirection) && opposingStructure && opposingMomentum;
  const continuationSupport = (bullishBias && eurUsdEntryConfirmation.longOk)
    || (bearishBias && eurUsdEntryConfirmation.shortOk);
  const structureSupport = (bullishBias && longStructureOk) || (bearishBias && shortStructureOk);
  const momentumSupport = (bullishBias && momentumLongOk) || (bearishBias && momentumShortOk);
  const hardStretch = !mildlyStretched;

  if (regime === 'DEAD') {
      return buildHoldResult(
        { ...context, ...biasDiagnostics },
        ['dead_market_regime'],
        { strategyName: 'bias', setupType: 'bias_hold', biasDirection: null, biasStrength: 'none', regime },
      );
  }

  if (emaSeparationAtr < 0.04) {
    const canSoftHoldFlatBias = isEurUsdBias
      && Boolean(biasDirection)
      && emaSeparationAtr >= 0.02
      && structureSupport
      && !hardStretch
      && (momentumSupport || continuationSupport);

    if (canSoftHoldFlatBias) {
      return buildHoldResult(
        { ...context, ...biasDiagnostics },
        ['ema_flat'],
        {
          strategyName: 'bias',
          setupType: 'bias_hold',
          biasDirection,
          biasStrength: structureSupport && momentumSupport && continuationSupport ? 'strong' : 'moderate',
          regime,
        },
      );
    }

    return buildHoldResult(
      { ...context, ...biasDiagnostics },
      ['ema_flat'],
      { strategyName: 'bias', setupType: 'bias_hold', biasDirection: null, biasStrength: 'none', regime },
    );
  }

  if (conflictingBias) {
    return buildHoldResult(
      { ...context, ...biasDiagnostics },
      ['conflicting_bias_signals'],
      { strategyName: 'bias', setupType: 'bias_hold', biasDirection: null, biasStrength: 'none', regime },
    );
  }

  if (!bullishBias && !bearishBias) {
    reasons.push('ema_not_aligned');
  } else if ((bullishBias && !longStructureOk) || (bearishBias && !shortStructureOk)) {
    reasons.push('structure_not_confirmed');
  }

  if (!pullbackOk) {
    reasons.push(mildlyStretched ? 'price_slightly_stretched' : 'price_too_stretched');
  }

  if ((bullishBias && !momentumLongOk) || (bearishBias && !momentumShortOk)) {
    reasons.push('rsi_not_confirmed');
  }

  if ((bullishBias && !longH1Aligned) || (bearishBias && !shortH1Aligned)) {
    reasons.push('weak_h1_bias');
  }

  if ((bullishBias && longStructureOk && pullbackOk && momentumLongOk && !eurUsdEntryConfirmation.longOk)
    || (bearishBias && shortStructureOk && pullbackOk && momentumShortOk && !eurUsdEntryConfirmation.shortOk)) {
    reasons.push('missing_trigger_candle');
  }

  if (reasons.length === 0) {
    reasons.push('bias_not_confirmed');
  }

  const biasStrength = !biasDirection || hardStretch
    ? biasDirection ? 'weak' : 'none'
    : structureSupport && momentumSupport && pullbackOk
      ? 'strong'
      : structureSupport || momentumSupport || pullbackOk
        ? 'moderate'
        : 'weak';

  return buildHoldResult(
    { ...context, ...biasDiagnostics },
    reasons,
    { strategyName: 'bias', setupType: 'bias_hold', biasDirection, biasStrength, regime },
  );
}

function evaluateMeanReversionStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, {
    ...options,
    ignoreAdxFilter: true,
  });

  if (context.hold) {
    return context.hold;
  }

  const period = Math.max(5, Number(config.strategy.bollingerPeriod || 20));
  const window = context.closes.slice(-period);
  const midBand = calculateSma(window, window.length);
  const stdDev = calculateStandardDeviation(window);

  if (!Number.isFinite(midBand) || !Number.isFinite(stdDev)) {
    return {
      signal: 'HOLD',
      reasons: ['insufficient_bollinger_data'],
      indicators: context,
    };
  }

  const upperBand = midBand + stdDev * Number(config.strategy.bollingerStdDev || 2);
  const lowerBand = midBand - stdDev * Number(config.strategy.bollingerStdDev || 2);
  const buyNearBand = context.latestClose <= lowerBand + Math.max(Number(context.atr) * 0.15, stdDev * 0.15);
  const sellNearBand = context.latestClose >= upperBand - Math.max(Number(context.atr) * 0.15, stdDev * 0.15);

  if (context.latestClose <= lowerBand && Number.isFinite(context.rsi) && context.rsi <= config.strategy.meanReversionRsiBuyMax) {
    return buildSetup('BUY', context.latestClose, context.atr, { ...context, upperBand, lowerBand, midBand }, {
      strategyName: 'mean_reversion',
      confidencePrefix: `Mean Rev | RSI ${context.rsi.toFixed(1)} | Band reclaim`,
    });
  }

  if (context.latestClose >= upperBand && Number.isFinite(context.rsi) && context.rsi >= config.strategy.meanReversionRsiSellMin) {
    return buildSetup('SELL', context.latestClose, context.atr, { ...context, upperBand, lowerBand, midBand }, {
      strategyName: 'mean_reversion',
      confidencePrefix: `Mean Rev | RSI ${context.rsi.toFixed(1)} | Band fade`,
    });
  }

  const reasons = [];
  let biasDirection = null;
  let biasStrength = 'none';

  if (buyNearBand) {
    biasDirection = 'BUY';
    biasStrength = Number.isFinite(context.rsi) && context.rsi <= config.strategy.meanReversionRsiBuyMax + 5 ? 'moderate' : 'weak';
    reasons.push('lower_band_not_reclaimed');
    if (!(Number.isFinite(context.rsi) && context.rsi <= config.strategy.meanReversionRsiBuyMax)) {
      reasons.push('rsi_not_oversold');
    }
  } else if (sellNearBand) {
    biasDirection = 'SELL';
    biasStrength = Number.isFinite(context.rsi) && context.rsi >= config.strategy.meanReversionRsiSellMin - 5 ? 'moderate' : 'weak';
    reasons.push('upper_band_not_rejected');
    if (!(Number.isFinite(context.rsi) && context.rsi >= config.strategy.meanReversionRsiSellMin)) {
      reasons.push('rsi_not_overbought');
    }
  } else {
    reasons.push('range_condition_invalid');
  }

  return buildHoldResult(
    { ...context, upperBand, lowerBand, midBand, buyNearBand, sellNearBand },
    reasons,
    { strategyName: 'mean_reversion', setupType: 'mean_reversion_hold', biasDirection, biasStrength, regime: context.regime },
  );
}

function calculateMacd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slowPeriod) {
    return null;
  }

  const ema = (values, period) => {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, val) => sum + Number(val), 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (Number(values[i]) - ema) * multiplier + ema;
    }

    return ema;
  };

  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  if (!Number.isFinite(fastEma) || !Number.isFinite(slowEma)) {
    return null;
  }

  const macdLine = fastEma - slowEma;
  const signalLine = ema([...closes].map((_, i) => {
    const f = ema(closes.slice(0, i + 1), fastPeriod);
    const s = ema(closes.slice(0, i + 1), slowPeriod);
    return f - s;
  }).filter(Number.isFinite), signalPeriod);

  return {
    macdLine,
    signalLine: Number.isFinite(signalLine) ? signalLine : macdLine,
    histogram: macdLine - (Number.isFinite(signalLine) ? signalLine : macdLine),
  };
}

function calculateStochastic(bars, kPeriod = 14, dPeriod = 3) {
  if (!Array.isArray(bars) || bars.length < kPeriod) {
    return null;
  }

  const recent = bars.slice(-kPeriod);
  const highestHigh = Math.max(...recent.map((bar) => Number(bar.high)));
  const lowestLow = Math.min(...recent.map((bar) => Number(bar.low)));
  const closePrice = Number(bars[bars.length - 1].close);

  if (highestHigh === lowestLow) {
    return { k: 50, d: 50 };
  }

  const kPercent = ((closePrice - lowestLow) / (highestHigh - lowestLow)) * 100;

  // For D, we'd need to track historical K values, so return K as approximation
  return {
    k: kPercent,
    d: kPercent, // Simplified: in production, track 3-period SMA of K
  };
}

function calculateVolumeProfile(bars, volumePeriod = 20) {
  if (!Array.isArray(bars) || bars.length < volumePeriod) {
    return null;
  }

  const recent = bars.slice(-volumePeriod);
  const volumes = recent.map((bar) => Number(bar.volume || 0));
  const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
  const currentVolume = Number(bars[bars.length - 1].volume || 0);

  return {
    avgVolume,
    currentVolume,
    volumeRatio: avgVolume > 0 ? currentVolume / avgVolume : 1,
  };
}

function calculateSupportResistance(bars, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < lookback) {
    return null;
  }

  const recent = bars.slice(-lookback);
  const highs = recent.map((bar) => Number(bar.high));
  const lows = recent.map((bar) => Number(bar.low));

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const price = Number(bars[bars.length - 1].close);

  // Identify pivot levels (multiple touches)
  const resistanceLevel = highs.filter((h) => h >= resistance * 0.99 && h <= resistance * 1.01).length >= 2 ? resistance : null;
  const supportLevel = lows.filter((l) => l <= support * 1.01 && l >= support * 0.99).length >= 2 ? support : null;

  return {
    resistance: resistanceLevel || resistance,
    support: supportLevel || support,
    current: price,
    distanceToResistance: (resistance - price) / price,
    distanceToSupport: (price - support) / price,
  };
}

function evaluateMacdStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, options);

  if (context.hold) {
    return context.hold;
  }

  const closes = bars.map((bar) => Number(bar.close));
  const macd = calculateMacd(closes);

  if (!macd) {
    return { signal: 'HOLD', reasons: ['insufficient_macd_data'], indicators: context };
  }

  const previousMacd = calculateMacd(closes.slice(0, -1));
  const macdCrossedAboveSignal = previousMacd && previousMacd.macdLine < previousMacd.signalLine && macd.macdLine > macd.signalLine;
  const macdCrossedBelowSignal = previousMacd && previousMacd.macdLine > previousMacd.signalLine && macd.macdLine < macd.signalLine;

  if (macdCrossedAboveSignal && Number.isFinite(context.rsi) && context.rsi >= Math.max(config.strategy.rsiLongMin - 10, 35)) {
    return buildSetup('BUY', context.latestClose, context.atr, { ...context, ...macd }, {
      strategyName: 'macd',
      confidencePrefix: `MACD Cross | RSI ${context.rsi.toFixed(1)} | Histogram ${macd.histogram.toFixed(4)}`,
    });
  }

  if (macdCrossedBelowSignal && Number.isFinite(context.rsi) && context.rsi <= Math.min(config.strategy.rsiShortMax + 10, 65)) {
    return buildSetup('SELL', context.latestClose, context.atr, { ...context, ...macd }, {
      strategyName: 'macd',
      confidencePrefix: `MACD Cross | RSI ${context.rsi.toFixed(1)} | Histogram ${macd.histogram.toFixed(4)}`,
    });
  }

  return {
    signal: 'HOLD',
    reasons: ['macd_not_aligned'],
    indicators: { ...context, ...macd },
  };
}

function evaluateStochasticStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, options);

  if (context.hold) {
    return context.hold;
  }

  const stoch = calculateStochastic(bars);

  if (!stoch) {
    return { signal: 'HOLD', reasons: ['insufficient_stochastic_data'], indicators: context };
  }

  // Oversold: K < 20
  if (stoch.k < 20 && Number.isFinite(context.rsi) && context.rsi < 40) {
    return buildSetup('BUY', context.latestClose, context.atr, { ...context, ...stoch }, {
      strategyName: 'stochastic',
      confidencePrefix: `Stoch Oversold (${stoch.k.toFixed(1)}) | RSI ${context.rsi.toFixed(1)}`,
    });
  }

  // Overbought: K > 80
  if (stoch.k > 80 && Number.isFinite(context.rsi) && context.rsi > 60) {
    return buildSetup('SELL', context.latestClose, context.atr, { ...context, ...stoch }, {
      strategyName: 'stochastic',
      confidencePrefix: `Stoch Overbought (${stoch.k.toFixed(1)}) | RSI ${context.rsi.toFixed(1)}`,
    });
  }

  return {
    signal: 'HOLD',
    reasons: ['stochastic_neutral'],
    indicators: { ...context, ...stoch },
  };
}

function evaluateVolumeStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, options);

  if (context.hold) {
    return context.hold;
  }

  const volume = calculateVolumeProfile(bars);

  if (!volume || volume.volumeRatio < 1.2) {
    return {
      signal: 'HOLD',
      reasons: ['insufficient_volume'],
      indicators: { ...context, ...volume },
    };
  }

  const closes = bars.map((bar) => Number(bar.close));
  const direction = evaluateTrendDirection(bars);

  // Strong volume with trend
  if (direction === 'BUY' && volume.volumeRatio >= 1.5 && Number.isFinite(context.rsi) && context.rsi >= 40) {
    return buildSetup('BUY', context.latestClose, context.atr, { ...context, ...volume }, {
      strategyName: 'volume',
      confidencePrefix: `Volume Spike ${volume.volumeRatio.toFixed(2)}x | Trend ${direction} | RSI ${context.rsi.toFixed(1)}`,
    });
  }

  if (direction === 'SELL' && volume.volumeRatio >= 1.5 && Number.isFinite(context.rsi) && context.rsi <= 60) {
    return buildSetup('SELL', context.latestClose, context.atr, { ...context, ...volume }, {
      strategyName: 'volume',
      confidencePrefix: `Volume Spike ${volume.volumeRatio.toFixed(2)}x | Trend ${direction} | RSI ${context.rsi.toFixed(1)}`,
    });
  }

  return {
    signal: 'HOLD',
    reasons: ['volume_not_aligned'],
    indicators: { ...context, ...volume },
  };
}

function evaluateSupportResistanceStrategy(bars, options = {}) {
  const context = buildBaseContext(bars, options);

  if (context.hold) {
    return context.hold;
  }

  const sr = calculateSupportResistance(bars);

  if (!sr) {
    return { signal: 'HOLD', reasons: ['insufficient_sr_data'], indicators: context };
  }

  // Break above resistance with volume
  const volume = calculateVolumeProfile(bars);
  const isVolumeStrong = volume && volume.volumeRatio >= 1.2;

  if (sr.current > sr.resistance && isVolumeStrong && Number.isFinite(context.rsi) && context.rsi >= 45) {
    return buildSetup('BUY', context.latestClose, context.atr, { ...context, ...sr }, {
      strategyName: 'support_resistance',
      confidencePrefix: `R-Breakout | Res: ${sr.resistance.toFixed(4)} | Vol: ${volume.volumeRatio.toFixed(2)}x`,
    });
  }

  // Break below support with volume
  if (sr.current < sr.support && isVolumeStrong && Number.isFinite(context.rsi) && context.rsi <= 55) {
    return buildSetup('SELL', context.latestClose, context.atr, { ...context, ...sr }, {
      strategyName: 'support_resistance',
      confidencePrefix: `S-Breakout | Sup: ${sr.support.toFixed(4)} | Vol: ${volume.volumeRatio.toFixed(2)}x`,
    });
  }

  // Bounce off support
  if (sr.distanceToSupport < 0.002 && sr.current > sr.support && Number.isFinite(context.rsi) && context.rsi >= 35) {
    return buildSetup('BUY', context.latestClose, context.atr, { ...context, ...sr }, {
      strategyName: 'support_resistance',
      confidencePrefix: `S-Bounce | Sup: ${sr.support.toFixed(4)} | RSI: ${context.rsi.toFixed(1)}`,
    });
  }

  // Rejection at resistance
  if (sr.distanceToResistance < 0.002 && sr.current < sr.resistance && Number.isFinite(context.rsi) && context.rsi <= 65) {
    return buildSetup('SELL', context.latestClose, context.atr, { ...context, ...sr }, {
      strategyName: 'support_resistance',
      confidencePrefix: `R-Rejection | Res: ${sr.resistance.toFixed(4)} | RSI: ${context.rsi.toFixed(1)}`,
    });
  }

  return {
    signal: 'HOLD',
    reasons: ['sr_no_setup'],
    indicators: { ...context, ...sr },
  };
}

const STRATEGIES = {
  trend: evaluateTrendStrategy,
  ema_pullback: evaluateEmaPullbackStrategy,
  bias: evaluateBiasStrategy,
  breakout: evaluateBreakoutStrategy,
  mean_reversion: evaluateMeanReversionStrategy,
  macd: evaluateMacdStrategy,
  stochastic: evaluateStochasticStrategy,
  volume: evaluateVolumeStrategy,
  support_resistance: evaluateSupportResistanceStrategy,
};

function generateSignal(bars, options = {}) {
  const strategyName = String(options.strategyName || config.strategy.name || 'trend').trim().toLowerCase();
  const evaluator = STRATEGIES[strategyName] || STRATEGIES.trend;
  return evaluator(bars, options);
}

module.exports = {
  STRATEGIES,
  calculateAdx,
  calculateAtr,
  calculateEma,
  calculateRiskMetrics,
  calculateRsi,
  calculateSma,
  calculateMacd,
  calculateStochastic,
  calculateVolumeProfile,
  calculateSupportResistance,
  evaluateTrendDirection,
  getSessionLabels,
  summarizeMarketContext,
  isWithinSession,
  generateSignal,
};
