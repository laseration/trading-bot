const { listSignals } = require('./resultTracker');

function getPipSize(symbol) {
  const normalized = String(symbol || '').toUpperCase();

  if (normalized.includes('JPY')) {
    return 0.01;
  }

  if (normalized === 'XAUUSD') {
    return 0.1;
  }

  if (normalized === 'XAGUSD') {
    return 0.01;
  }

  if (normalized === 'CL-OIL' || normalized === 'GASOIL-C') {
    return 0.01;
  }

  if (/^[A-Z]{6}$/.test(normalized)) {
    return 0.0001;
  }

  return 0.01;
}

function calculateDirectionalPoints({ symbol, direction, entry, exit }) {
  const numericEntry = Number(entry);
  const numericExit = Number(exit);

  if (!Number.isFinite(numericEntry) || !Number.isFinite(numericExit)) {
    return null;
  }

  const pipSize = getPipSize(symbol);
  const rawDifference = String(direction || '').toUpperCase() === 'SELL'
    ? numericEntry - numericExit
    : numericExit - numericEntry;

  return Number((rawDifference / pipSize).toFixed(1));
}

function resolveRecordedEntry(record) {
  const executionEntry = Number(record && record.execution && record.execution.executionPrice);
  if (Number.isFinite(executionEntry)) {
    return executionEntry;
  }

  const plannedEntry = Number(record && record.entry);
  return Number.isFinite(plannedEntry) ? plannedEntry : null;
}

function resolveRecordedExit(record) {
  const executionExit = Number(record && record.execution && record.execution.exitPrice);
  if (Number.isFinite(executionExit)) {
    return executionExit;
  }

  return null;
}

function normalizeSignedResult(value, finalOutcome) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (finalOutcome === 'loss') {
    return -Math.abs(numeric);
  }

  if (finalOutcome === 'win') {
    return Math.abs(numeric);
  }

  return Number(numeric.toFixed(1));
}

function calculateSignalResult(record) {
  if (!record) {
    return null;
  }

  const realizedExit = resolveRecordedExit(record);
  const realizedEntry = resolveRecordedEntry(record);

  if (Number.isFinite(realizedEntry) && Number.isFinite(realizedExit)) {
    return normalizeSignedResult(calculateDirectionalPoints({
      symbol: record.symbol,
      direction: record.direction,
      entry: realizedEntry,
      exit: realizedExit,
    }), record.finalOutcome);
  }

  if (Number.isFinite(Number(record.pipsOrPointsResult))) {
    return normalizeSignedResult(record.pipsOrPointsResult, record.finalOutcome);
  }

  const takeProfits = Array.isArray(record.takeProfits) ? record.takeProfits : [];
  const highestTp = Number(record.highestTpHit || 0);

  if (record.status === 'sl_hit') {
    return calculateDirectionalPoints({
      symbol: record.symbol,
      direction: record.direction,
      entry: resolveRecordedEntry(record),
      exit: Number((record.execution && record.execution.stopLoss) ?? record.stopLoss),
    });
  }

  if (record.status === 'closed' && Number.isFinite(resolveRecordedExit(record))) {
    return calculateDirectionalPoints({
      symbol: record.symbol,
      direction: record.direction,
      entry: resolveRecordedEntry(record),
      exit: resolveRecordedExit(record),
    });
  }

  if (record.status === 'closed' && highestTp > 0 && takeProfits[highestTp - 1] != null) {
    return calculateDirectionalPoints({
      symbol: record.symbol,
      direction: record.direction,
      entry: resolveRecordedEntry(record),
      exit: takeProfits[highestTp - 1],
    });
  }

  return null;
}

function aggregatePerformance(records = []) {
  const settledRecords = records.filter((record) => ['sl_hit', 'closed', 'cancelled'].includes(record.status));
  const wins = settledRecords.filter((record) => record.finalOutcome === 'win').length;
  const losses = settledRecords.filter((record) => record.finalOutcome === 'loss').length;
  const tp1Hits = records.filter((record) => Number(record.highestTpHit) >= 1).length;
  const tp2Hits = records.filter((record) => Number(record.highestTpHit) >= 2).length;
  const tp3Hits = records.filter((record) => Number(record.highestTpHit) >= 3).length;
  const totalSignals = records.filter((record) => record.type === 'signal').length;
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
  const netPoints = settledRecords.reduce((total, record) => {
    const result = calculateSignalResult(record);
    return total + (Number.isFinite(result) ? result : 0);
  }, 0);

  const byPair = new Map();

  for (const record of settledRecords) {
    const current = byPair.get(record.symbol) || { total: 0, wins: 0, netPoints: 0 };
    current.total += 1;
    current.wins += record.finalOutcome === 'win' ? 1 : 0;
    const result = calculateSignalResult(record);
    current.netPoints += Number.isFinite(result) ? result : 0;
    byPair.set(record.symbol, current);
  }

  let bestPair = null;

  for (const [symbol, pairStats] of byPair.entries()) {
    const pairScore = pairStats.total > 0 ? pairStats.wins / pairStats.total : 0;

    if (
      !bestPair ||
      pairScore > bestPair.score ||
      (pairScore === bestPair.score && pairStats.netPoints > bestPair.netPoints)
    ) {
      bestPair = {
        symbol,
        score: pairScore,
        winRate: pairStats.total > 0 ? Number(((pairStats.wins / pairStats.total) * 100).toFixed(1)) : 0,
        netPoints: Number(pairStats.netPoints.toFixed(1)),
      };
    }
  }

  return {
    totalSignals,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    tp1Hits,
    tp2Hits,
    tp3Hits,
    netPoints: Number(netPoints.toFixed(1)),
    bestPair,
    settledSignals: settledRecords.length,
  };
}

function buildTradeDetails(records = []) {
  return records
    .filter((record) => ['sl_hit', 'closed', 'cancelled'].includes(record.status))
    .map((record) => ({
      id: record.id,
      symbol: record.symbol,
      direction: record.direction,
      outcome: record.finalOutcome || (record.status === 'cancelled' ? 'cancelled' : 'unknown'),
      status: record.status,
      netPoints: calculateSignalResult(record),
      updatedAt: record.updatedAt || record.postedAt || record.enteredAt || '',
      source: record.sourceLabel || record.sourceChannelName || record.sourceChannelId || '',
    }))
    .sort((left, right) => Date.parse(left.updatedAt || 0) - Date.parse(right.updatedAt || 0));
}

function resolveSourceKey(record) {
  return record.sourceLabel || record.sourceChannelName || record.sourceChannelId || 'Unknown Source';
}

function normalizeDimensionValue(value, fallback = 'UNKNOWN') {
  const normalized = String(value || '').trim();
  return normalized ? normalized.toUpperCase() : fallback;
}

function buildLearningKey(parts = []) {
  return parts.map((part) => normalizeDimensionValue(part)).join('|');
}

function calculateLearningScore({ winRate = 0, avgPoints = 0, settledSignals = 0, minSettledSignals = 1 }) {
  const confidenceFactor = settledSignals > 0
    ? Math.min(1, settledSignals / Math.max(1, minSettledSignals))
    : 0;
  return Number(((winRate * 0.75) + (avgPoints * 6) * 0.25 * confidenceFactor).toFixed(1));
}

function buildLearningStats(records = [], keyBuilder, options = {}) {
  const minSettledSignals = Number(options.minSettledSignals || 1);
  const byKey = new Map();

  for (const record of records.filter((entry) => entry.type === 'signal')) {
    const key = keyBuilder(record);

    if (!key) {
      continue;
    }

    const current = byKey.get(key) || {
      key,
      totalSignals: 0,
      settledSignals: 0,
      wins: 0,
      losses: 0,
      netPoints: 0,
    };

    current.totalSignals += 1;

    if (['sl_hit', 'closed', 'cancelled'].includes(record.status)) {
      current.settledSignals += 1;
      current.wins += record.finalOutcome === 'win' ? 1 : 0;
      current.losses += record.finalOutcome === 'loss' ? 1 : 0;
      const result = calculateSignalResult(record);
      current.netPoints += Number.isFinite(result) ? result : 0;
    }

    byKey.set(key, current);
  }

  return byKey;
}

function summarizeLearningEntry(entry, options = {}) {
  if (!entry) {
    return null;
  }

  const winRate = entry.wins + entry.losses > 0 ? (entry.wins / (entry.wins + entry.losses)) * 100 : 0;
  const avgPoints = entry.settledSignals > 0 ? entry.netPoints / entry.settledSignals : 0;

  return {
    ...entry,
    winRate: Number(winRate.toFixed(1)),
    netPoints: Number(entry.netPoints.toFixed(1)),
    avgPoints: Number(avgPoints.toFixed(1)),
    score: calculateLearningScore({
      winRate,
      avgPoints,
      settledSignals: entry.settledSignals,
      minSettledSignals: options.minSettledSignals,
    }),
  };
}

function aggregateSourcePerformance(records = [], options = {}) {
  const minSettledSignals = Number(options.minSettledSignals || 0);
  const bySource = new Map();

  for (const record of records.filter((entry) => entry.type === 'signal')) {
    const key = resolveSourceKey(record);
    const current = bySource.get(key) || {
      source: key,
      sourceChannelId: record.sourceChannelId || '',
      totalSignals: 0,
      settledSignals: 0,
      wins: 0,
      losses: 0,
      tp1Hits: 0,
      tp2Hits: 0,
      tp3Hits: 0,
      netPoints: 0,
    };

    current.totalSignals += 1;
    current.tp1Hits += Number(record.highestTpHit) >= 1 ? 1 : 0;
    current.tp2Hits += Number(record.highestTpHit) >= 2 ? 1 : 0;
    current.tp3Hits += Number(record.highestTpHit) >= 3 ? 1 : 0;

    if (['sl_hit', 'closed', 'cancelled'].includes(record.status)) {
      current.settledSignals += 1;
      current.wins += record.finalOutcome === 'win' ? 1 : 0;
      current.losses += record.finalOutcome === 'loss' ? 1 : 0;
      const result = calculateSignalResult(record);
      current.netPoints += Number.isFinite(result) ? result : 0;
    }

    bySource.set(key, current);
  }

  const sources = Array.from(bySource.values())
    .map((entry) => {
      const winRate = entry.wins + entry.losses > 0 ? (entry.wins / (entry.wins + entry.losses)) * 100 : 0;
      const avgPoints = entry.settledSignals > 0 ? entry.netPoints / entry.settledSignals : 0;
      const confidenceFactor = entry.settledSignals > 0 ? Math.min(1, entry.settledSignals / Math.max(1, minSettledSignals || 1)) : 0;
      const score = Number((winRate * confidenceFactor + avgPoints * 0.35).toFixed(1));

      return {
        ...entry,
        winRate: Number(winRate.toFixed(1)),
        netPoints: Number(entry.netPoints.toFixed(1)),
        avgPoints: Number(avgPoints.toFixed(1)),
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.winRate !== left.winRate) {
        return right.winRate - left.winRate;
      }

      return right.netPoints - left.netPoints;
    });

  return {
    sources,
    bestSource: sources[0] || null,
  };
}

function aggregateWeeklyPerformance({ startAt, endAt } = {}) {
  const startTime = startAt ? Date.parse(startAt) : Date.now() - 7 * 24 * 60 * 60 * 1000;
  const endTime = endAt ? Date.parse(endAt) : Date.now();
  const records = listSignals().filter((record) => {
    const referenceTime = Date.parse(record.updatedAt || record.postedAt || record.enteredAt || 0);
    return Number.isFinite(referenceTime) && referenceTime >= startTime && referenceTime <= endTime;
  });

  return {
    startAt: new Date(startTime).toISOString(),
    endAt: new Date(endTime).toISOString(),
    records,
    summary: aggregatePerformance(records),
    sourceSummary: aggregateSourcePerformance(records),
    tradeDetails: buildTradeDetails(records),
  };
}

function getSourcePerformanceForSignal(signal, options = {}) {
  const lookbackDays = Number(options.lookbackDays || 30);
  const minSettledSignals = Number(options.minSettledSignals || 0);
  const endTime = Date.now();
  const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
  const matchingSource = resolveSourceKey(signal);
  const records = listSignals().filter((record) => {
    const referenceTime = Date.parse(record.updatedAt || record.postedAt || record.enteredAt || 0);
    return Number.isFinite(referenceTime) && referenceTime >= startTime && referenceTime <= endTime;
  });
  const { sources } = aggregateSourcePerformance(records, { minSettledSignals });
  return sources.find((entry) => entry.source === matchingSource) || null;
}

function getLearningAssessmentForSignal(signal, options = {}) {
  const lookbackDays = Number(options.lookbackDays || 45);
  const minSettledSignals = Number(options.minSettledSignals || 5);
  const endTime = Date.now();
  const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
  const records = listSignals().filter((record) => {
    const referenceTime = Date.parse(record.updatedAt || record.postedAt || record.enteredAt || 0);
    return Number.isFinite(referenceTime) && referenceTime >= startTime && referenceTime <= endTime;
  });

  const sourceKey = resolveSourceKey(signal);
  const symbolKey = normalizeDimensionValue(signal.symbol);
  const timeframeKey = normalizeDimensionValue(signal.timeframe, 'ANY');
  const directionKey = normalizeDimensionValue(signal.direction || signal.side, 'ANY');

  const builders = [
    {
      label: 'source',
      key: buildLearningKey([sourceKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([resolveSourceKey(record)]), { minSettledSignals }),
    },
    {
      label: 'symbol',
      key: buildLearningKey([symbolKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([record.symbol]), { minSettledSignals }),
    },
    {
      label: 'timeframe',
      key: buildLearningKey([timeframeKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([record.timeframe || 'ANY']), { minSettledSignals }),
    },
    {
      label: 'direction',
      key: buildLearningKey([directionKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([record.direction || 'ANY']), { minSettledSignals }),
    },
    {
      label: 'source_symbol',
      key: buildLearningKey([sourceKey, symbolKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([resolveSourceKey(record), record.symbol]), { minSettledSignals }),
    },
    {
      label: 'symbol_direction',
      key: buildLearningKey([symbolKey, directionKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([record.symbol, record.direction || 'ANY']), { minSettledSignals }),
    },
    {
      label: 'source_symbol_timeframe',
      key: buildLearningKey([sourceKey, symbolKey, timeframeKey]),
      stats: buildLearningStats(records, (record) => buildLearningKey([resolveSourceKey(record), record.symbol, record.timeframe || 'ANY']), { minSettledSignals }),
    },
  ];

  const dimensions = builders
    .map((entry) => ({
      label: entry.label,
      stats: summarizeLearningEntry(entry.stats.get(entry.key), { minSettledSignals }),
    }))
    .filter((entry) => entry.stats);

  const settledSignals = dimensions.reduce((highest, entry) => Math.max(highest, entry.stats.settledSignals), 0);
  const weighted = dimensions.filter((entry) => entry.stats.settledSignals > 0);
  const aggregateScore = weighted.length > 0
    ? Number((weighted.reduce((total, entry) => total + entry.stats.score, 0) / weighted.length).toFixed(1))
    : null;
  const wins = weighted.reduce((total, entry) => total + entry.stats.wins, 0);
  const losses = weighted.reduce((total, entry) => total + entry.stats.losses, 0);
  const inferredWinRate = wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : null;

  return {
    signalId: signal.id || '',
    dimensions,
    aggregateScore,
    inferredWinRate,
    settledSignals,
    hasEnoughData: settledSignals >= minSettledSignals,
  };
}

function aggregateDailyPerformance({ date } = {}) {
  const anchor = date ? new Date(date) : new Date();
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const records = listSignals().filter((record) => {
    const referenceTime = Date.parse(record.updatedAt || record.postedAt || record.enteredAt || 0);
    return Number.isFinite(referenceTime) && referenceTime >= start.getTime() && referenceTime < end.getTime();
  });

  return {
    date: start.toISOString().slice(0, 10),
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    records,
    summary: aggregatePerformance(records),
    tradeDetails: buildTradeDetails(records),
  };
}

module.exports = {
  aggregateDailyPerformance,
  aggregatePerformance,
  aggregateSourcePerformance,
  aggregateWeeklyPerformance,
  buildTradeDetails,
  getLearningAssessmentForSignal,
  calculateDirectionalPoints,
  calculateSignalResult,
  getSourcePerformanceForSignal,
  getPipSize,
  normalizeSignedResult,
  resolveRecordedEntry,
  resolveRecordedExit,
};
