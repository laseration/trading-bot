const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log, logTradeEvent, logEquity } = require('./logger');
const { getHistoricalBars, getLatestPrice } = require('./dataFeed');
const { hasRecentRelevantNews } = require('./newsAnalyzer');
const { generateSignal } = require('./strategy');
const { calculatePositionSize } = require('./risk');
const broker = require('./broker');

const startingEquityBySymbol = {};
const dailyStartingEquityBySymbol = {};
const openTradeCostBySymbol = {};
const sameSetupDebounceByKey = new Map();
const consumedStrategySetupsByKey = new Map();
const tradeHistoryPath = path.join(__dirname, '..', 'logs', 'trade-history.csv');
const tradeHistoryCache = {
  mtimeMs: 0,
  rows: [],
};

function resolveProfile(symbolOrProfile) {
  if (symbolOrProfile && typeof symbolOrProfile === 'object') {
    return symbolOrProfile;
  }

  return {
    symbol: symbolOrProfile,
    market: typeof symbolOrProfile === 'string' && symbolOrProfile.includes('/') ? 'crypto' : 'stock',
    dataSource: 'alpaca',
    signalSource: 'strategy',
    broker: config.paperTradingMode ? 'paper' : 'alpaca',
  };
}

function normalizeSignal(signal) {
  if (typeof signal !== 'string') {
    return 'HOLD';
  }

  const upper = signal.toUpperCase();
  return ['BUY', 'SELL', 'HOLD'].includes(upper) ? upper : 'HOLD';
}

function getExecutionPrice(orderResult, fallbackPrice) {
  const fillPrice = Number(orderResult && orderResult.fillPrice);
  const validatedPrice = Number(orderResult && orderResult.validatedPrice);

  if (Number.isFinite(fillPrice) && fillPrice > 0) {
    return fillPrice;
  }

  if (Number.isFinite(validatedPrice) && validatedPrice > 0) {
    return validatedPrice;
  }

  return fallbackPrice;
}

function logOrderPriceDetails(symbol, referencePrice, orderResult) {
  if (!orderResult) {
    return;
  }

  if (Number.isFinite(Number(orderResult.validatedPrice))) {
    log(`[${symbol}] Broker validation price: ${Number(orderResult.validatedPrice)}`);
  }

  if (Number.isFinite(Number(orderResult.fillPrice))) {
    log(`[${symbol}] Broker fill price: ${Number(orderResult.fillPrice)}`);
  }

  if (Number.isFinite(Number(orderResult.expectedPrice)) && Number(orderResult.expectedPrice) !== referencePrice) {
    log(`[${symbol}] Bot reference price: ${Number(orderResult.expectedPrice)}`);
  }
}

function resolveInitialProtection(normalizedSignal) {
  const stopLoss = Number(normalizedSignal && normalizedSignal.stopLoss);
  const takeProfits = Array.isArray(normalizedSignal && normalizedSignal.takeProfits)
    ? normalizedSignal.takeProfits.map((value) => Number(value)).filter(Number.isFinite)
    : [];

  return {
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
    takeProfit: takeProfits.length > 0 ? takeProfits[takeProfits.length - 1] : null,
  };
}

function resolveSignalIdentity(signalSource, symbol, strategySetup, cycleTimestamp, latestBarTime = null) {
  const triggerBarTime = strategySetup && strategySetup.triggerBarTime
    ? String(strategySetup.triggerBarTime)
    : latestBarTime != null
      ? String(latestBarTime)
    : String(cycleTimestamp);
  const setupHash = strategySetup && strategySetup.setupHash
    ? String(strategySetup.setupHash)
    : [
        signalSource,
        symbol,
        strategySetup && strategySetup.strategyName || '',
        strategySetup && strategySetup.signal || '',
        strategySetup && Array.isArray(strategySetup.reasons) ? strategySetup.reasons.join('|') : '',
        triggerBarTime,
      ].join(':');

  return {
    id: `${signalSource}:${symbol}:${triggerBarTime}:${setupHash}`,
    setupHash,
    triggerBarTime,
  };
}

function parseTimeframeToMs(timeframe) {
  const normalized = String(timeframe || '').trim().toUpperCase();
  const match = normalized.match(/^([MHDW])(\d+)$/);

  if (!match) {
    return 60 * 60 * 1000;
  }

  const unit = match[1];
  const value = Number(match[2]);

  if (!(value > 0)) {
    return 60 * 60 * 1000;
  }

  if (unit === 'M') {
    return value * 60 * 1000;
  }

  if (unit === 'H') {
    return value * 60 * 60 * 1000;
  }

  if (unit === 'D') {
    return value * 24 * 60 * 60 * 1000;
  }

  if (unit === 'W') {
    return value * 7 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
}

function getConsumedSetupTtlMs(timeframe) {
  const timeframeMs = parseTimeframeToMs(timeframe);
  return Math.max(timeframeMs * 2, 60 * 60 * 1000);
}

function buildConsumedStrategySetupKey(symbol, normalizedSignal = {}) {
  const setupHash = String(normalizedSignal.setupHash || '').trim();
  const triggerBarTime = String(normalizedSignal.triggerBarTime || '').trim();
  const normalizedSymbol = String(symbol || normalizedSignal.symbol || '').toUpperCase();

  if (!normalizedSymbol || !setupHash || !triggerBarTime) {
    return null;
  }

  return `${normalizedSymbol}|${triggerBarTime}|${setupHash}`;
}

function cleanupConsumedStrategySetups(now = Date.now()) {
  for (const [key, state] of consumedStrategySetupsByKey.entries()) {
    if (!state || !Number.isFinite(state.expiresAt) || state.expiresAt <= now) {
      consumedStrategySetupsByKey.delete(key);
    }
  }
}

function getConsumedStrategySetupState(setupKey, timeframe, now = Date.now()) {
  cleanupConsumedStrategySetups(now);

  if (!setupKey) {
    return { active: false, remainingMs: 0, expiresAt: null };
  }

  const existing = consumedStrategySetupsByKey.get(setupKey);

  if (!existing) {
    return { active: false, remainingMs: 0, expiresAt: null };
  }

  const ttlMs = getConsumedSetupTtlMs(timeframe);
  const expiresAt = Number.isFinite(existing.expiresAt)
    ? existing.expiresAt
    : (Number(existing.consumedAt) || now) + ttlMs;
  const remainingMs = expiresAt - now;

  if (!(remainingMs > 0)) {
    consumedStrategySetupsByKey.delete(setupKey);
    return { active: false, remainingMs: 0, expiresAt: null };
  }

  return {
    active: true,
    consumedAt: existing.consumedAt || null,
    expiresAt,
    remainingMs,
    reason: existing.reason || 'consumed',
  };
}

function markStrategySetupConsumed(setupKey, normalizedSignal = {}, reason = 'approved', now = Date.now()) {
  if (!setupKey) {
    return null;
  }

  const ttlMs = getConsumedSetupTtlMs(normalizedSignal.timeframe || config.strategy.timeframe);
  const consumedAt = now;
  const expiresAt = now + ttlMs;
  const state = {
    consumedAt,
    expiresAt,
    reason,
    setupHash: normalizedSignal.setupHash || null,
    triggerBarTime: normalizedSignal.triggerBarTime || null,
  };

  consumedStrategySetupsByKey.set(setupKey, state);
  cleanupConsumedStrategySetups(now);
  return state;
}

function logSetupLifecycle(symbol, normalizedSignal = {}, state, details = '') {
  log(
    `[SETUP_LIFECYCLE] ${String(symbol || normalizedSignal.symbol || '').toUpperCase()}`
    + ` state=${state}`
    + ` setupHash=${normalizedSignal.setupHash || 'na'}`
    + ` triggerBarTime=${normalizedSignal.triggerBarTime || 'na'}`
    + `${details ? ` ${details}` : ''}`,
  );
}

function hasPreferredExecutionSession(normalizedSignal) {
  const session = String(normalizedSignal && normalizedSignal.session || '').toUpperCase();
  return session.includes('LONDON') || session.includes('NEWYORK');
}

function resolveReversalCloseSide(existingPosition) {
  const normalizedPosition = Number(existingPosition);

  if (!Number.isFinite(normalizedPosition) || normalizedPosition === 0) {
    return null;
  }

  return normalizedPosition > 0 ? 'SELL' : 'BUY';
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < String(line || '').length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readClosedTradeHistoryRows() {
  try {
    const stats = fs.statSync(tradeHistoryPath);

    if (tradeHistoryCache.mtimeMs === stats.mtimeMs) {
      return tradeHistoryCache.rows;
    }

    const raw = fs.readFileSync(tradeHistoryPath, 'utf8').trim();

    if (!raw) {
      tradeHistoryCache.mtimeMs = stats.mtimeMs;
      tradeHistoryCache.rows = [];
      return tradeHistoryCache.rows;
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => {
      const values = parseCsvLine(line);
      return headers.reduce((accumulator, header, index) => {
        accumulator[header] = values[index] ?? '';
        return accumulator;
      }, {});
    });

    tradeHistoryCache.mtimeMs = stats.mtimeMs;
    tradeHistoryCache.rows = rows;
    return rows;
  } catch (err) {
    return [];
  }
}

function getEurUsdLossStreakState(now = Date.now()) {
  const trigger = Number(config.safetyControls.eurusdLossStreakTrigger || 0);
  const cooldownMinutes = Number(config.safetyControls.eurusdLossStreakCooldownMinutes || 0);

  if (!(trigger > 0) || !(cooldownMinutes > 0)) {
    return {
      active: false,
      consecutiveLosses: 0,
      latestLossAt: null,
      cooldownEndsAt: null,
      remainingMs: 0,
    };
  }

  const strategyRows = readClosedTradeHistoryRows()
    .filter((row) => String(row.symbol || '').toUpperCase() === 'EURUSD')
    .filter((row) => String(row.source_type || '').toLowerCase() === 'strategy')
    .filter((row) => String(row.close_reason || '').toLowerCase() !== 'partial_close');

  let consecutiveLosses = 0;
  let latestLossAt = null;

  for (let index = strategyRows.length - 1; index >= 0; index -= 1) {
    const row = strategyRows[index];
    const pnl = Number(row.pnl);

    if (!Number.isFinite(pnl)) {
      continue;
    }

    if (pnl < 0) {
      consecutiveLosses += 1;
      latestLossAt = latestLossAt || row.closed_at || row.exit_time || null;

      if (consecutiveLosses >= trigger) {
        break;
      }

      continue;
    }

    break;
  }

  if (consecutiveLosses < trigger || !latestLossAt) {
    return {
      active: false,
      consecutiveLosses,
      latestLossAt,
      cooldownEndsAt: null,
      remainingMs: 0,
    };
  }

  const cooldownEndsAtMs = new Date(latestLossAt).getTime() + cooldownMinutes * 60 * 1000;
  const remainingMs = cooldownEndsAtMs - now;

  return {
    active: remainingMs > 0,
    consecutiveLosses,
    latestLossAt,
    cooldownEndsAt: new Date(cooldownEndsAtMs).toISOString(),
    remainingMs: Math.max(0, remainingMs),
  };
}

function roundToPriceZone(price, zoneSize) {
  if (!(Number.isFinite(price) && price > 0) || !(zoneSize > 0)) {
    return null;
  }

  return Number((Math.round(price / zoneSize) * zoneSize).toFixed(5));
}

function resolveEurUsdBiasZoneSize(regime) {
  return String(regime || '').toUpperCase() === 'RANGING'
    ? Number(config.safetyControls.eurusdRangingBiasZoneSize || 0.001)
    : 0.0005;
}

function resolveEurUsdFailedZoneSize(regime) {
  return resolveEurUsdBiasZoneSize(regime);
}

function extractSetupTypeFromNotes(notes) {
  const match = String(notes || '').match(/(?:^|\s|\|)setupType=([^|\s]+)/i);
  return match ? match[1] : '';
}

function normalizeSetupType(value) {
  const setupType = String(value || '').trim().toLowerCase();
  return setupType || 'UNKNOWN';
}

function buildEurUsdFailedZoneKey(direction, regime, priceZone, setupType = 'UNKNOWN') {
  if (!['BUY', 'SELL'].includes(String(direction || '').toUpperCase()) || !(Number.isFinite(priceZone) && priceZone > 0)) {
    return null;
  }

  return [
    'EURUSD',
    'bias',
    normalizeSetupType(setupType),
    String(direction || '').toUpperCase(),
    String(regime || '').toUpperCase() || 'UNKNOWN',
    priceZone.toFixed(5),
  ].join('|');
}

function getEurUsdSetupDebounceMinutes(normalizedSignal) {
  const strategyName = String(normalizedSignal && normalizedSignal.strategyName || '').toLowerCase();
  const regime = String(normalizedSignal && normalizedSignal.regime || '').toUpperCase();

  if (strategyName === 'bias' && regime === 'RANGING') {
    return Number(config.safetyControls.eurusdRangingBiasDebounceMinutes || config.safetyControls.eurusdSameSetupDebounceMinutes || 0);
  }

  return Number(config.safetyControls.eurusdSameSetupDebounceMinutes || 0);
}

function getEurUsdGlobalLossCooldownState(normalizedSignal = {}, now = Date.now()) {
  const cooldownMinutes = Number(config.safetyControls.eurusdGlobalLossCooldownMinutes || 0);

  if (
    String(normalizedSignal.symbol || 'EURUSD').toUpperCase() !== 'EURUSD'
    || String(normalizedSignal.strategyName || '').toLowerCase() !== 'bias'
    || !(cooldownMinutes > 0)
  ) {
    return {
      active: false,
      latestLossAt: null,
      cooldownEndsAt: null,
      remainingMs: 0,
      lastDirection: null,
      lastRegime: null,
    };
  }

  const recentRows = readClosedTradeHistoryRows()
    .filter((row) => String(row.symbol || '').toUpperCase() === 'EURUSD')
    .filter((row) => String(row.source_type || '').toLowerCase() === 'strategy')
    .filter((row) => String(row.strategy_name || '').toLowerCase() === 'bias')
    .filter((row) => String(row.close_reason || '').toLowerCase() !== 'partial_close');

  for (let index = recentRows.length - 1; index >= 0; index -= 1) {
    const row = recentRows[index];
    const pnl = Number(row.pnl);
    const closedAt = new Date(row.closed_at || row.exit_time || 0).getTime();

    if (!Number.isFinite(pnl) || pnl >= 0 || !Number.isFinite(closedAt)) {
      continue;
    }

    const cooldownEndsAtMs = closedAt + cooldownMinutes * 60 * 1000;
    const remainingMs = cooldownEndsAtMs - now;

    return {
      active: remainingMs > 0,
      latestLossAt: new Date(closedAt).toISOString(),
      cooldownEndsAt: new Date(cooldownEndsAtMs).toISOString(),
      remainingMs: Math.max(0, remainingMs),
      lastDirection: String(row.side || '').toUpperCase() || null,
      lastRegime: String(row.regime || '').toUpperCase() || null,
    };
  }

  return {
    active: false,
    latestLossAt: null,
    cooldownEndsAt: null,
    remainingMs: 0,
    lastDirection: null,
    lastRegime: null,
  };
}

function buildEurUsdSetupDebounceKey(normalizedSignal, fallbackPrice) {
  const direction = String(normalizedSignal && normalizedSignal.direction || '').toUpperCase();
  const strategyName = String(normalizedSignal && normalizedSignal.strategyName || '').toLowerCase();
  const biasStrength = String(normalizedSignal && normalizedSignal.biasStrength || '').toLowerCase();
  const setupType = normalizeSetupType(normalizedSignal && normalizedSignal.setupType);
  const regime = String(normalizedSignal && normalizedSignal.regime || '').toUpperCase();
  const referencePrice = Number(normalizedSignal && normalizedSignal.entry);
  const isRangingBias = strategyName === 'bias' && regime === 'RANGING';
  const priceZone = roundToPriceZone(
    Number.isFinite(referencePrice) ? referencePrice : Number(fallbackPrice),
    resolveEurUsdBiasZoneSize(regime),
  );

  if (!['BUY', 'SELL'].includes(direction) || strategyName !== 'bias' || !priceZone) {
    return null;
  }

  return [
    'EURUSD',
    strategyName,
    setupType,
    direction,
    priceZone.toFixed(5),
    regime || 'UNKNOWN',
    isRangingBias ? 'ranging_thesis' : (biasStrength || 'none'),
  ].join('|');
}

function getSetupDebounceState(setupKey, debounceMinutes, now = Date.now()) {

  if (!setupKey || !(debounceMinutes > 0)) {
    return { active: false, remainingMs: 0 };
  }

  const debounceMs = debounceMinutes * 60 * 1000;
  const previousSeenAt = sameSetupDebounceByKey.get(setupKey);

  if (!(Number.isFinite(previousSeenAt) && previousSeenAt > 0)) {
    return { active: false, remainingMs: 0 };
  }

  const remainingMs = debounceMs - (now - previousSeenAt);
  return {
    active: remainingMs > 0,
    remainingMs: Math.max(0, remainingMs),
  };
}

function markSetupSeen(setupKey, debounceMinutes, now = Date.now()) {
  if (!setupKey) {
    return;
  }

  sameSetupDebounceByKey.set(setupKey, now);

  const maxAgeMs = Number(debounceMinutes || 0) * 60 * 1000;

  for (const [key, seenAt] of sameSetupDebounceByKey.entries()) {
    if (!Number.isFinite(seenAt) || now - seenAt > maxAgeMs * 2) {
      sameSetupDebounceByKey.delete(key);
    }
  }
}

function getRecentEurUsdFailedZoneState(normalizedSignal, fallbackPrice, now = Date.now()) {
  const direction = String(normalizedSignal && normalizedSignal.direction || '').toUpperCase();
  const strategyName = String(normalizedSignal && normalizedSignal.strategyName || '').toLowerCase();
  const setupType = normalizeSetupType(normalizedSignal && normalizedSignal.setupType);
  const regime = String(normalizedSignal && normalizedSignal.regime || '').toUpperCase();
  const cooldownMinutes = Number(config.safetyControls.eurusdFailedZoneCooldownMinutes || 0);

  if (
    String(normalizedSignal && normalizedSignal.symbol || 'EURUSD').toUpperCase() !== 'EURUSD'
    || strategyName !== 'bias'
    || !['BUY', 'SELL'].includes(direction)
    || !(cooldownMinutes > 0)
  ) {
    return {
      active: false,
      sameThesisAttempts: 0,
      lossCount: 0,
      latestLossAt: null,
      cooldownEndsAt: null,
      remainingMs: 0,
      priceZone: null,
      regime,
      zoneKey: null,
    };
  }

  const referencePrice = Number(normalizedSignal && normalizedSignal.entry);
  const priceZone = roundToPriceZone(
    Number.isFinite(referencePrice) ? referencePrice : Number(fallbackPrice),
    resolveEurUsdFailedZoneSize(regime),
  );

  if (!priceZone) {
    return {
      active: false,
      sameThesisAttempts: 0,
      lossCount: 0,
      latestLossAt: null,
      cooldownEndsAt: null,
      remainingMs: 0,
      priceZone: null,
      regime,
      zoneKey: null,
    };
  }

  const zoneKey = buildEurUsdFailedZoneKey(direction, regime, priceZone, setupType);
  const recentRows = readClosedTradeHistoryRows()
    .filter((row) => String(row.symbol || '').toUpperCase() === 'EURUSD')
    .filter((row) => String(row.source_type || '').toLowerCase() === 'strategy')
    .filter((row) => String(row.strategy_name || '').toLowerCase() === 'bias')
    .filter((row) => String(row.side || '').toUpperCase() === direction)
    .filter((row) => normalizeSetupType(row.setup_type || extractSetupTypeFromNotes(row.notes)) === setupType)
    .filter((row) => String(row.close_reason || '').toLowerCase() !== 'partial_close');
  let sameThesisAttempts = 0;
  let lossCount = 0;
  let latestLossAtMs = null;
  const escalationEnabled = config.safetyControls.eurusdFailedZoneEscalationEnabled === true;
  const maxCooldownMinutes = 24 * 60;

  for (let index = recentRows.length - 1; index >= 0; index -= 1) {
    const row = recentRows[index];
    const closedAt = new Date(row.closed_at || row.exit_time || 0).getTime();

    if (!Number.isFinite(closedAt)) {
      continue;
    }

    if (now - closedAt > maxCooldownMinutes * 60 * 1000) {
      break;
    }

    const rowRegime = String(row.regime || '').toUpperCase();
    if (regime && rowRegime && rowRegime !== regime) {
      continue;
    }

    const rowEntry = Number(row.entry_price);
    const rowZone = roundToPriceZone(rowEntry, resolveEurUsdFailedZoneSize(row.regime || regime));

    if (rowZone !== priceZone) {
      continue;
    }

    sameThesisAttempts += 1;
    const pnl = Number(row.pnl);

    if (Number.isFinite(pnl) && pnl < 0) {
      lossCount += 1;
      latestLossAtMs = latestLossAtMs || closedAt;
    }
  }

  const cooldownMultiplier = !escalationEnabled || lossCount <= 1
    ? 1
    : lossCount === 2
      ? 2
      : 8;
  const effectiveCooldownMinutes = Math.min(maxCooldownMinutes, cooldownMinutes * cooldownMultiplier);

  if (latestLossAtMs != null) {
    const cooldownEndsAtMs = latestLossAtMs + effectiveCooldownMinutes * 60 * 1000;
    const remainingMs = cooldownEndsAtMs - now;

    return {
      active: remainingMs > 0,
      sameThesisAttempts,
      lossCount,
      latestLossAt: new Date(latestLossAtMs).toISOString(),
      cooldownEndsAt: new Date(cooldownEndsAtMs).toISOString(),
      remainingMs: Math.max(0, remainingMs),
      priceZone,
      regime,
      zoneKey,
    };
  }

  return {
    active: false,
    sameThesisAttempts,
    lossCount,
    latestLossAt: null,
    cooldownEndsAt: null,
    remainingMs: 0,
    priceZone,
    regime,
    zoneKey,
  };
}

async function loadStrategySetup(profile, options = {}) {
  const entryBars = await getHistoricalBars(profile, {
    count: config.strategy.lookbackBars,
    timeframe: config.strategy.timeframe,
  });
  const confirmationBarsByTimeframe = {};

  for (const timeframe of config.strategy.confirmationTimeframes || []) {
    confirmationBarsByTimeframe[timeframe] = await getHistoricalBars(profile, {
      count: Math.max(config.strategy.lookbackBars, config.strategy.longMa + 5),
      timeframe,
    });
  }

  const recentNewsCooldown = await hasRecentRelevantNews(profile.symbol, config.strategy.newsCooldownMinutes);
  const setup = generateSignal(entryBars, {
    strategyName: options.strategyName || profile.strategyName || config.strategy.name,
    symbol: profile.symbol,
    confirmationBarsByTimeframe,
    hasRecentRelevantNews: recentNewsCooldown,
    currentTimeMs: Date.now(),
  });
  const latestBar = Array.isArray(entryBars) && entryBars.length > 0 ? entryBars[entryBars.length - 1] : null;

  return {
    setup,
    latestPrice: Number(latestBar && latestBar.close),
    latestBarTime: latestBar && latestBar.time != null ? latestBar.time : null,
  };
}

async function prepareBotRun(symbolOrProfile, options = {}) {
  const profile = resolveProfile(symbolOrProfile);
  const symbol = profile.symbol;
  const cycleTimestamp = new Date().toISOString();
  let price = Number(options.price);
  let strategySetup = null;
  let latestBarTime = null;
  const signalSource = options.signalSource || profile.signalSource || 'strategy';

  if (!(Number.isFinite(price) && price > 0)) {
    if (options.signal == null && signalSource === 'strategy') {
      const strategyEvaluation = await loadStrategySetup(profile, options);
      strategySetup = strategyEvaluation.setup;
      latestBarTime = strategyEvaluation.latestBarTime;

      if (Number.isFinite(Number(strategySetup && strategySetup.entry))) {
        price = Number(strategySetup.entry);
      } else {
        price = strategyEvaluation.latestPrice;
      }
    }

    if (!(Number.isFinite(price) && price > 0)) {
      price = await getLatestPrice(profile);
    }
  }

  const signal = normalizeSignal(options.signal ?? (strategySetup && strategySetup.signal));
  let normalizedSignal = options.normalizedSignal || null;

  if (strategySetup && !options.normalizedSignal) {
    const signalIdentity = resolveSignalIdentity(signalSource, symbol, strategySetup, cycleTimestamp, latestBarTime);
    normalizedSignal = {
      id: signalIdentity.id,
      symbol,
      direction: signal,
      entry: Number.isFinite(Number(strategySetup.entry)) ? Number(strategySetup.entry) : price,
      stopLoss: strategySetup.stopLoss,
      takeProfits: strategySetup.takeProfits,
      timeframe: strategySetup.timeframe,
      strategyName: strategySetup.strategyName,
      confidenceLabel: strategySetup.confidenceLabel,
      indicators: strategySetup.indicators,
      strategyReasons: Array.isArray(strategySetup.reasons) ? strategySetup.reasons : [],
      biasDirection: strategySetup.biasDirection || null,
      biasStrength: strategySetup.biasStrength || 'none',
      strategyFamily: strategySetup.strategyFamily || strategySetup.strategyName || null,
      setupType: strategySetup.setupType || strategySetup.strategyName || null,
      setupHash: signalIdentity.setupHash,
      triggerBarTime: signalIdentity.triggerBarTime,
      validUntilBar: strategySetup.validUntilBar || signalIdentity.triggerBarTime,
      rrTp1: Number.isFinite(Number(strategySetup.rrTp1)) ? Number(strategySetup.rrTp1) : null,
      rrFinal: Number.isFinite(Number(strategySetup.rrFinal)) ? Number(strategySetup.rrFinal) : null,
      regime: strategySetup.regime || (strategySetup.indicators && strategySetup.indicators.regime) || null,
      stopDistance: strategySetup.stopDistance,
      sourceLabel: `Strategy ${strategySetup.strategyName || profile.strategyName || config.strategy.name}`,
      rawText: `Strategy ${strategySetup.strategyName || profile.strategyName || config.strategy.name} ${signal} ${symbol}`,
      timestamp: cycleTimestamp,
    };
  }

  if (normalizedSignal) {
    const recentFailedZoneState = symbol === 'EURUSD'
      && String(normalizedSignal.strategyName || strategySetup && strategySetup.strategyName || '').toLowerCase() === 'bias'
      && ['BUY', 'SELL'].includes(String(normalizedSignal.direction || signal).toUpperCase())
      ? getRecentEurUsdFailedZoneState(normalizedSignal, price, Date.now())
      : null;

    normalizedSignal = {
      ...normalizedSignal,
      symbol,
      direction: normalizedSignal.direction || signal,
      timestamp: normalizedSignal.timestamp || cycleTimestamp,
      setupHash: normalizedSignal.setupHash || (strategySetup && strategySetup.setupHash) || resolveSignalIdentity(signalSource, symbol, strategySetup, cycleTimestamp, latestBarTime).setupHash,
      triggerBarTime: normalizedSignal.triggerBarTime || (strategySetup && strategySetup.triggerBarTime) || latestBarTime || null,
      validUntilBar: normalizedSignal.validUntilBar || (strategySetup && strategySetup.validUntilBar) || normalizedSignal.triggerBarTime || latestBarTime || null,
      rrTp1: Number.isFinite(Number(normalizedSignal.rrTp1))
        ? Number(normalizedSignal.rrTp1)
        : Number.isFinite(Number(strategySetup && strategySetup.rrTp1))
          ? Number(strategySetup.rrTp1)
          : null,
      rrFinal: Number.isFinite(Number(normalizedSignal.rrFinal))
        ? Number(normalizedSignal.rrFinal)
        : Number.isFinite(Number(strategySetup && strategySetup.rrFinal))
          ? Number(strategySetup.rrFinal)
          : null,
      sameThesisAttemptCount: recentFailedZoneState ? recentFailedZoneState.sameThesisAttempts : Number(normalizedSignal.sameThesisAttemptCount || 0),
      recentFailedZone: recentFailedZoneState ? {
        active: recentFailedZoneState.active,
        cooldownEndsAt: recentFailedZoneState.cooldownEndsAt,
        latestLossAt: recentFailedZoneState.latestLossAt,
        remainingMs: recentFailedZoneState.remainingMs,
        priceZone: recentFailedZoneState.priceZone,
        regime: recentFailedZoneState.regime,
        zoneKey: recentFailedZoneState.zoneKey,
        lossCount: recentFailedZoneState.lossCount,
      } : normalizedSignal.recentFailedZone || null,
    };
  }

  return {
    profile,
    symbol,
    cycleKey: profile.id || symbol,
    cycleTimestamp,
    signalSource,
    price,
    signal,
    normalizedSignal,
    strategySetup,
  };
}

async function runBot(symbolOrProfile, options = {}) {
  const prepared = options.prepared || await prepareBotRun(symbolOrProfile, options);
  const {
    profile,
    symbol,
    cycleKey,
    cycleTimestamp,
    signalSource,
    price,
    signal,
    normalizedSignal,
    strategySetup,
  } = prepared;
  const symbolSettings = config.getSymbolSettings(symbol);
  const result = {
    symbol,
    signal,
    signalSource,
    action: 'none',
    executed: false,
    blocked: false,
    orderRejected: false,
    executionPrice: null,
    qty: null,
    stopLoss: null,
    takeProfit: null,
    orderResult: null,
    accountPositionBefore: null,
    normalizedSignal,
  };

  log(`------ BOT STEP ${symbol} ------`);
  log(`[${symbol}] Price: ${price}`);
  log(`[${symbol}] Signal: ${signal}`);
  log(`[${symbol}] Signal source: ${signalSource}`);

  if (strategySetup && Array.isArray(strategySetup.reasons) && strategySetup.reasons.length > 0) {
    log(`[${symbol}] Strategy hold reasons: ${strategySetup.reasons.join(', ')}`);
  }

  if (strategySetup && strategySetup.confidenceLabel) {
    log(`[${symbol}] Strategy confirmation: ${strategySetup.confidenceLabel}`);
  }

  if (strategySetup && strategySetup.strategyName) {
    log(`[${symbol}] Strategy type: ${strategySetup.strategyName}`);
  }

  const account = await broker.getAccountState(profile, price);
  result.accountPositionBefore = account.position;
  const startingEquity = startingEquityBySymbol[cycleKey];

  if (startingEquity == null) {
    startingEquityBySymbol[cycleKey] = account.equity;
    log(`[${symbol}] Starting equity set to: ${startingEquityBySymbol[cycleKey]}`);
  }

  const dailyKey = `${cycleKey}:${cycleTimestamp.slice(0, 10)}`;
  if (dailyStartingEquityBySymbol[dailyKey] == null) {
    dailyStartingEquityBySymbol[dailyKey] = account.equity;
    log(`[${symbol}] Daily starting equity set to: ${dailyStartingEquityBySymbol[dailyKey]}`);
  }

  const currentStartingEquity = startingEquityBySymbol[cycleKey];
  const drawdown = (currentStartingEquity - account.equity) / currentStartingEquity;
  const currentDailyStartingEquity = dailyStartingEquityBySymbol[dailyKey];
  const dailyDrawdown = currentDailyStartingEquity > 0
    ? (currentDailyStartingEquity - account.equity) / currentDailyStartingEquity
    : 0;

  if (drawdown >= config.risk.maxDrawdownPct) {
    log(`[${symbol}] Kill switch triggered. Drawdown: ${(drawdown * 100).toFixed(2)}%`);
    result.blocked = true;
    result.action = 'blocked_drawdown';
    return result;
  }

  if (dailyDrawdown >= Number(symbolSettings.maxDailyLossPct || config.risk.maxDailyLossPct)) {
    log(`[${symbol}] Daily loss guard triggered. Drawdown: ${(dailyDrawdown * 100).toFixed(2)}%`);
    result.blocked = true;
    result.action = 'blocked_daily_loss';
    return result;
  }

  const isEurUsdStrategyEntry = symbol === 'EURUSD'
    && signalSource === 'strategy'
    && normalizedSignal
    && String(normalizedSignal.strategyName || '').toLowerCase() === 'bias'
    && ['BUY', 'SELL'].includes(signal);
  const isStrategyExecutableSetup = signalSource === 'strategy'
    && normalizedSignal
    && ['BUY', 'SELL'].includes(signal);
  const currentTimeMs = Date.now();
  let setupDebounceKey = null;
  let consumedSetupKey = null;

  if (isEurUsdStrategyEntry) {
    const globalLossCooldownState = getEurUsdGlobalLossCooldownState(normalizedSignal, currentTimeMs);
    const currentRegime = String(normalizedSignal.regime || '').toUpperCase();
    const directionChangedIntoTrending = globalLossCooldownState.lastDirection
      && String(signal || '').toUpperCase() !== globalLossCooldownState.lastDirection
      && currentRegime === 'TRENDING';

    if (globalLossCooldownState.active && !directionChangedIntoTrending) {
      log(
        `[${symbol}] Blocking strategy entry: global_loss_cooldown `
        + `symbol=${symbol} direction=${signal} regime=${currentRegime || 'UNKNOWN'} `
        + `latestLossAt=${globalLossCooldownState.latestLossAt || 'na'} `
        + `cooldownEndsAt=${globalLossCooldownState.cooldownEndsAt || 'na'}`,
      );
      result.blocked = true;
      result.action = 'global_loss_cooldown';
      return result;
    }

    const lossStreakState = getEurUsdLossStreakState(currentTimeMs);

    if (lossStreakState.active) {
      log(
        `[${symbol}] Blocking strategy entry: eurusd_loss_pause_active `
        + `(loss_streak_cooldown after ${lossStreakState.consecutiveLosses} consecutive losses `
        + `until ${lossStreakState.cooldownEndsAt})`,
      );
      result.blocked = true;
      result.action = 'loss_streak_cooldown';
      return result;
    }

    const recentFailedZoneState = getRecentEurUsdFailedZoneState(normalizedSignal, price, currentTimeMs);

    if (recentFailedZoneState.active) {
      log(
        `[${symbol}] recent_failed_zone_block `
        + `symbol=${symbol} direction=${signal} regime=${recentFailedZoneState.regime || currentRegime || 'UNKNOWN'} `
        + `zone=${recentFailedZoneState.priceZone?.toFixed(5) || 'na'} `
        + `latestLossAt=${recentFailedZoneState.latestLossAt || 'na'} `
        + `cooldownEndsAt=${recentFailedZoneState.cooldownEndsAt || 'na'} `
        + `lossCount=${recentFailedZoneState.lossCount || 0}`,
      );
      result.blocked = true;
      result.action = 'recent_failed_zone_block';
      return result;
    }

    setupDebounceKey = buildEurUsdSetupDebounceKey(normalizedSignal, price);
    const debounceMinutes = getEurUsdSetupDebounceMinutes(normalizedSignal);
    const debounceState = getSetupDebounceState(setupDebounceKey, debounceMinutes, currentTimeMs);

    if (debounceState.active) {
      log(
        `[${symbol}] Blocking strategy entry: setup_recently_seen `
        + `(duplicate_setup_debounced for ${(debounceState.remainingMs / 1000).toFixed(0)}s)`,
      );
      result.blocked = true;
      result.action = 'duplicate_setup_debounced';
      return result;
    }

    markSetupSeen(setupDebounceKey, debounceMinutes, currentTimeMs);
  }

  if (isStrategyExecutableSetup) {
    consumedSetupKey = buildConsumedStrategySetupKey(symbol, normalizedSignal);
    const consumedState = getConsumedStrategySetupState(
      consumedSetupKey,
      normalizedSignal.timeframe || config.strategy.timeframe,
      currentTimeMs,
    );

    if (consumedState.active) {
      logSetupLifecycle(
        symbol,
        normalizedSignal,
        'blocked_consumed',
        `expiresInMs=${Math.round(consumedState.remainingMs)} consumedReason=${consumedState.reason || 'consumed'}`,
      );
      result.blocked = true;
      result.action = 'blocked_consumed';
      return result;
    }

    const consumedStateRecord = markStrategySetupConsumed(
      consumedSetupKey,
      normalizedSignal,
      'approved',
      currentTimeMs,
    );

    if (consumedStateRecord) {
      log(
        `[${symbol}] Consumed strategy setup ${normalizedSignal.setupHash || 'na'}`
        + ` triggerBarTime=${normalizedSignal.triggerBarTime || 'na'}`
        + ` until ${new Date(consumedStateRecord.expiresAt).toISOString()}`,
      );
    }
  }

  const currentPositionAbs = Math.abs(Number(account.position) || 0);
  const maxPositionSize = Number(symbolSettings.maxPositionSize || config.risk.maxPositionSize || 0);
  const isPositionReversal = (signal === "BUY" && account.position < 0) || (signal === "SELL" && account.position > 0);
  const canScaleInBiasTrade = symbol === 'EURUSD'
    && signalSource === 'strategy'
    && normalizedSignal
    && String(normalizedSignal.strategyName || '').toLowerCase() === 'bias'
    && String(normalizedSignal.biasStrength || '').toLowerCase() === 'strong'
    && hasPreferredExecutionSession(normalizedSignal)
    && Number(normalizedSignal.approvalScore) >= 60
    && maxPositionSize > 0
    && currentPositionAbs > 0
    && currentPositionAbs < (maxPositionSize * 0.8);
  const shouldTrimOversizedPosition = maxPositionSize > 0
    && currentPositionAbs > maxPositionSize
    && !isPositionReversal;

  if (shouldTrimOversizedPosition) {
    const trimQty = Number((currentPositionAbs - maxPositionSize).toFixed(2));
    const trimSide = account.position > 0 ? 'SELL' : 'BUY';

    log(
      `[${symbol}] Existing position ${account.position} exceeds cap ${maxPositionSize}. `
      + `Trimming ${trimQty} via ${trimSide}.`,
    );

    if (trimQty > 0) {
      logTradeEvent({
        timestamp: new Date().toISOString(),
        symbol,
        event_type: 'order_placed',
        side: trimSide,
        qty: trimQty,
        price,
        position: account.position,
        position_id: '',
        order_id: '',
        status: 'submitted',
        notes: 'Submitting trim order',
      });
      const trimOrderResult = await broker.placeOrder(profile, trimSide, trimQty, price, {
        signalSource,
        rawSignal: options.rawSignal,
        comment: `${config.mt5Bridge.commentPrefix}:${symbol}:${trimSide}_TRIM`,
      });

      result.orderResult = trimOrderResult;
      result.qty = trimQty;

      if (trimOrderResult && trimOrderResult.rejected) {
        log(`[${symbol}] Position trim rejected: ${trimOrderResult.reason}`);
        result.blocked = true;
        result.orderRejected = true;
        result.action = 'position_trim_rejected';
        return result;
      }

      const trimExecutionPrice = getExecutionPrice(trimOrderResult, price);
      logOrderPriceDetails(symbol, price, trimOrderResult);
      log(`[${symbol}] Position trimmed: ${trimSide} ${trimQty} @ ${trimExecutionPrice}`);
      logTradeEvent({
        timestamp: new Date().toISOString(),
        symbol,
        event_type: 'position_reduced',
        side: trimSide,
        qty: trimQty,
        price: trimExecutionPrice,
        position: account.position,
        position_id: trimOrderResult && (trimOrderResult.positionId ?? ''),
        order_id: trimOrderResult && (trimOrderResult.orderId ?? trimOrderResult.ticket),
        status: trimOrderResult && trimOrderResult.status,
        notes: 'Auto-trim to symbol position cap',
      });
      result.executed = true;
      result.action = 'position_trimmed';
      result.executionPrice = trimExecutionPrice;
      return result;
    }
  }

  const isOversizedLong = signal === 'BUY' && account.position > 0 && maxPositionSize > 0 && currentPositionAbs > maxPositionSize;
  const isOversizedShort = signal === 'SELL' && account.position < 0 && maxPositionSize > 0 && currentPositionAbs > maxPositionSize;

  if (isOversizedLong || isOversizedShort) {
    log(
      `[${symbol}] Existing position ${account.position} exceeds cap ${maxPositionSize}. `
      + `Blocking additional ${signal} exposure.`,
    );
    result.blocked = true;
    result.action = 'blocked_position_cap';
    return result;
  }

  // Handle position reversals: close opposing position first, then open new position
  if (isPositionReversal) {
    const opposingPosition = Math.abs(account.position);
    const closeSide = resolveReversalCloseSide(account.position);
    const existingPositionSide = Number(account.position) > 0 ? 'LONG' : Number(account.position) < 0 ? 'SHORT' : 'FLAT';
    const newSignalSide = signal;

    if (!closeSide) {
      log(
        `[${symbol}] Reversal close skipped: unable to resolve existing position side `
        + `existingPositionSide=${existingPositionSide} newSignalSide=${newSignalSide} reason=reversal_flatten_before_reverse`,
      );
      result.blocked = true;
      result.action = 'reversal_close_side_unknown';
      return result;
    }

    log(
      `[${symbol}] Position reversal detected. existingPositionSide=${existingPositionSide} `
      + `newSignalSide=${newSignalSide} closeSide=${closeSide} `
      + `qty=${opposingPosition} reason=reversal_flatten_before_reverse`,
    );
    
    // Step 1: Close the existing opposing position
    logTradeEvent({
      timestamp: new Date().toISOString(),
      symbol,
      event_type: 'order_placed',
      side: closeSide,
      qty: opposingPosition,
      price,
      position: account.position,
      position_id: '',
      order_id: '',
      status: 'submitted',
      notes: 'Submitting reversal close order',
    });
    const closeOrderResult = await broker.placeOrder(profile, closeSide, opposingPosition, price, {
      signalSource,
      rawSignal: options.rawSignal,
      comment: `${config.mt5Bridge.commentPrefix}:${symbol}:${closeSide}_CLOSE_REVERSAL`,
    });
    
    if (closeOrderResult && !closeOrderResult.rejected) {
      const closeExecutionPrice = getExecutionPrice(closeOrderResult, price);
      logOrderPriceDetails(symbol, price, closeOrderResult);
      log(`[${symbol}] Position closed for reversal: ${closeSide} ${opposingPosition} @ ${closeExecutionPrice}`);
      logTradeEvent({
        timestamp: new Date().toISOString(),
        symbol,
        event_type: 'position_closed',
        side: closeSide,
        qty: opposingPosition,
        price: closeExecutionPrice,
        position: 0,
        position_id: closeOrderResult && (closeOrderResult.positionId ?? ''),
        order_id: closeOrderResult && (closeOrderResult.orderId ?? closeOrderResult.ticket),
        status: closeOrderResult && closeOrderResult.status,
        notes: 'Closed opposing position for reversal',
      });
      
      // Calculate PnL from closing the position
      const openTradeCost = openTradeCostBySymbol[symbol];
      if (openTradeCost != null) {
        const closePnl = opposingPosition * closeExecutionPrice - config.commissionPerTrade - openTradeCost;
        log(`[${symbol}] Close PnL: ${closePnl.toFixed(2)}`);
      }
      openTradeCostBySymbol[symbol] = null;
    } else {
      log(`[${symbol}] Failed to close position for reversal: ${closeOrderResult && closeOrderResult.reason}`);
      result.blocked = true;
      result.action = 'reversal_close_failed';
      return result;
    }
    
    // Refresh account state after closing position
    const refreshedAccount = await broker.getAccountState(profile, price);
    account.position = refreshedAccount.position;
    account.cash = refreshedAccount.cash;
  }

  if (signal === "BUY" && (account.position <= 0 || canScaleInBiasTrade)) {
    const size = calculatePositionSize(account.equity, price, {
      symbol,
      stopLoss: normalizedSignal && normalizedSignal.stopLoss,
      stopDistance: normalizedSignal && normalizedSignal.stopDistance,
      riskPerTrade: symbolSettings.riskPerTrade,
      maxPositionSize: symbolSettings.maxPositionSize,
      requireStopDistance: config.risk.requireStopDistance,
    });
    const availableQty = maxPositionSize > 0 ? Math.max(0, Number((maxPositionSize - currentPositionAbs).toFixed(2))) : null;
    const targetQty = availableQty != null && availableQty > 0
      ? Math.min(options.qty ?? size, availableQty)
      : (options.qty ?? size);
    const protection = resolveInitialProtection(normalizedSignal);
    result.stopLoss = protection.stopLoss;
    result.takeProfit = protection.takeProfit;

    if (!(targetQty > 0) && config.risk.requireStopDistance && ['strategy', 'telegram', 'news'].includes(String(signalSource || '').toLowerCase())) {
      log(`[${symbol}] BUY blocked: no valid stop distance for sizing`);
      result.blocked = true;
      result.action = 'blocked_missing_stop_distance';
    } else if (targetQty > 0) {
      logTradeEvent({
        timestamp: new Date().toISOString(),
        symbol,
        event_type: 'order_placed',
        side: 'BUY',
        qty: targetQty,
        price,
        position: account.position,
        position_id: '',
        order_id: '',
        status: 'submitted',
        notes: 'Submitting long entry order',
      });
      const orderResult = await broker.placeOrder(profile, "BUY", targetQty, price, {
        signalSource,
        rawSignal: options.rawSignal,
        comment: `${config.mt5Bridge.commentPrefix}:${symbol}:BUY`,
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
      });
      result.orderResult = orderResult;
      result.qty = targetQty;

      if (orderResult && orderResult.rejected) {
        log(`[${symbol}] BUY rejected: ${orderResult.reason}`);
        result.orderRejected = true;
        result.action = 'buy_rejected';
      } else {
        const executionPrice = getExecutionPrice(orderResult, price);
        openTradeCostBySymbol[symbol] = targetQty * executionPrice + config.commissionPerTrade;
        logOrderPriceDetails(symbol, price, orderResult);
        log(`[${symbol}] BUY executed: size=${targetQty} price=${executionPrice}`);
        if (isStrategyExecutableSetup) {
          logSetupLifecycle(symbol, normalizedSignal, 'entered', `action=buy_entered qty=${targetQty}`);
        }
        result.executed = true;
        result.action = 'buy_entered';
        result.executionPrice = executionPrice;
        const tradeAccount = await broker.getAccountState(profile, executionPrice);
        logTradeEvent({
          timestamp: new Date().toISOString(),
          symbol,
          event_type: 'position_opened',
          side: "BUY",
          qty: targetQty,
          price: executionPrice,
          position: tradeAccount.position,
          position_id: orderResult && (orderResult.positionId ?? ''),
          order_id: orderResult && (orderResult.orderId ?? orderResult.ticket),
          status: orderResult && orderResult.status,
          notes: account.position > 0 ? 'Bias scale-in long entry' : 'Initial long entry',
        });
      }
    } else {
      log(`[${symbol}] BUY skipped: position size was 0`);
      result.action = 'buy_skipped';
    }
  } else if (signal === "SELL" && (account.position >= 0 || canScaleInBiasTrade)) {
    const size = calculatePositionSize(account.equity, price, {
      symbol,
      stopLoss: normalizedSignal && normalizedSignal.stopLoss,
      stopDistance: normalizedSignal && normalizedSignal.stopDistance,
      riskPerTrade: symbolSettings.riskPerTrade,
      maxPositionSize: symbolSettings.maxPositionSize,
      requireStopDistance: config.risk.requireStopDistance,
    });
    const availableQty = maxPositionSize > 0 ? Math.max(0, Number((maxPositionSize - currentPositionAbs).toFixed(2))) : null;
    const targetQty = availableQty != null && availableQty > 0
      ? Math.min(options.qty ?? size, availableQty)
      : (options.qty ?? size);
    const openTradeCost = openTradeCostBySymbol[symbol];
    const protection = resolveInitialProtection(normalizedSignal);
    result.stopLoss = protection.stopLoss;
    result.takeProfit = protection.takeProfit;
    
    if (!(targetQty > 0) && config.risk.requireStopDistance && ['strategy', 'telegram', 'news'].includes(String(signalSource || '').toLowerCase())) {
      log(`[${symbol}] SELL blocked: no valid stop distance for sizing`);
      result.blocked = true;
      result.action = 'blocked_missing_stop_distance';
    } else if (targetQty > 0) {
      logTradeEvent({
        timestamp: new Date().toISOString(),
        symbol,
        event_type: 'order_placed',
        side: 'SELL',
        qty: targetQty,
        price,
        position: account.position,
        position_id: '',
        order_id: '',
        status: 'submitted',
        notes: 'Submitting sell order',
      });
      const orderResult = await broker.placeOrder(profile, "SELL", targetQty, price, {
        signalSource,
        rawSignal: options.rawSignal,
        comment: `${config.mt5Bridge.commentPrefix}:${symbol}:SELL`,
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
      });
      result.orderResult = orderResult;
      result.qty = targetQty;

      if (orderResult && orderResult.rejected) {
        log(`[${symbol}] SELL rejected: ${orderResult.reason}`);
        result.orderRejected = true;
        result.action = 'sell_rejected';
      } else {
        const executionPrice = getExecutionPrice(orderResult, price);
        const pnl = openTradeCost == null
          ? ""
          : targetQty * executionPrice - config.commissionPerTrade - openTradeCost;

        logOrderPriceDetails(symbol, price, orderResult);
        log(`[${symbol}] SELL executed: size=${targetQty} price=${executionPrice}`);
        if (isStrategyExecutableSetup) {
          logSetupLifecycle(symbol, normalizedSignal, 'entered', `action=sell_executed qty=${targetQty}`);
        }
        result.executed = true;
        result.action = 'sell_executed';
        result.executionPrice = executionPrice;
        if (pnl !== "") {
          log(`[${symbol}] Trade PnL: ${pnl.toFixed(2)}`);
        }
        const tradeAccount = await broker.getAccountState(profile, executionPrice);
        logTradeEvent({
          timestamp: new Date().toISOString(),
          symbol,
          event_type: tradeAccount.position < 0 ? 'position_opened' : 'position_closed',
          side: "SELL",
          qty: targetQty,
          price: executionPrice,
          position: tradeAccount.position,
          position_id: orderResult && (orderResult.positionId ?? ''),
          order_id: orderResult && (orderResult.orderId ?? orderResult.ticket),
          status: orderResult && orderResult.status,
          notes: tradeAccount.position < 0
            ? (account.position < 0 ? 'Bias scale-in short entry' : 'Initial short entry')
            : 'Sell execution event',
        });
        openTradeCostBySymbol[symbol] = null;
      }
    } else {
      log(`[${symbol}] SELL skipped: position size was 0`);
      result.action = 'sell_skipped';
    }
  } else {
    log(`[${symbol}] No trade`);
    result.action = signal === 'BUY' ? 'buy_waiting' : signal === 'SELL' ? 'sell_waiting' : 'hold';
    if (isStrategyExecutableSetup && ['buy_waiting', 'sell_waiting'].includes(result.action)) {
      logSetupLifecycle(symbol, normalizedSignal, 'blocked_waiting', `action=${result.action} accountPosition=${account.position}`);
    }
  }

  const updatedAccount = await broker.getAccountState(profile, price);
  log(`[${symbol}] Cash: ${updatedAccount.cash}`);
  log(`[${symbol}] Position: ${updatedAccount.position}`);
  log(`[${symbol}] Equity: ${updatedAccount.equity}`);
  logEquity({
    timestamp: new Date().toISOString(),
    symbol,
    cash: updatedAccount.cash,
    position: updatedAccount.position,
    equity: updatedAccount.equity,
  });

  return result;
}

module.exports = { runBot, loadStrategySetup, prepareBotRun };
