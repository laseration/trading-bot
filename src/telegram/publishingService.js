const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log, logDecision, logTrade, logTradeEvent } = require('../logger');
const { generateResultCard } = require('../images/generateResultCard');
const { generateSignalCard } = require('../images/generateSignalCard');
const { generateWeeklyReportCard } = require('../images/generateWeeklyReportCard');
const { applyTradeUpdate } = require('../signals/statusUpdater');
const { classifyRiskLevel } = require('../signals/assessRiskLevel');
const { getLatestPrice } = require('../dataFeed');
const { getLearningAssessmentForSignal, getSourcePerformanceForSignal } = require('../signals/performanceAggregator');
const {
  markSignalStatus,
  markSignalEntered,
  markSignalPostFailed,
  markSignalPosted,
  upsertSignalRecord,
} = require('../signals/resultTracker');
const { getSessionLabels } = require('../strategy');
const { formatSignalMessage } = require('./formatSignalMessage');
const { formatTradeUpdateMessage } = require('./formatTradeUpdateMessage');
const { formatDailySummary, formatWeeklySummary } = require('./formatWeeklySummary');
const { postToChannel } = require('./postToChannel');
const { getPostingConfig } = require('./telegramApi');

const queueStatePath = path.join(__dirname, '..', '..', 'logs', 'public-signal-queue.json');

function ensureQueueDir() {
  fs.mkdirSync(path.dirname(queueStatePath), { recursive: true });
}

function emptyQueueState() {
  return {
    version: 1,
    candidates: [],
    postHistory: [],
    analytics: {
      created: 0,
      approved: 0,
      queued: 0,
      rejected: 0,
      dropped: 0,
      posted: 0,
      bySymbol: {},
      byRiskLevel: {},
      postedScores: [],
    },
  };
}

function readQueueState() {
  ensureQueueDir();

  if (!fs.existsSync(queueStatePath)) {
    return emptyQueueState();
  }

  try {
    const raw = fs.readFileSync(queueStatePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : emptyQueueState();
  } catch (err) {
    return emptyQueueState();
  }
}

function writeQueueState(state) {
  ensureQueueDir();
  fs.writeFileSync(queueStatePath, JSON.stringify(state, null, 2));
}

function recordAnalytics(state, signal, key, value = 1) {
  if (!state.analytics) {
    state.analytics = emptyQueueState().analytics;
  }

  state.analytics[key] = Number(state.analytics[key] || 0) + value;

  if (signal && signal.symbol) {
    const symbolKey = String(signal.symbol).toUpperCase();
    state.analytics.bySymbol[symbolKey] = Number(state.analytics.bySymbol[symbolKey] || 0) + value;
  }

  if (signal && signal.riskLevel) {
    const riskKey = String(signal.riskLevel).toUpperCase();
    state.analytics.byRiskLevel[riskKey] = Number(state.analytics.byRiskLevel[riskKey] || 0) + value;
  }
}

function minutesAgo(timestamp) {
  const parsed = Date.parse(timestamp || 0);

  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, (Date.now() - parsed) / 60000);
}

function getDirectionalBias(signal) {
  const direction = String(signal.direction || signal.side || '').toUpperCase();
  const indicators = signal.indicators || {};
  const emaFast = Number(indicators.emaFast ?? indicators.shortMa);
  const emaSlow = Number(indicators.emaSlow ?? indicators.longMa);

  if (!Number.isFinite(emaFast) || !Number.isFinite(emaSlow)) {
    return 'UNKNOWN';
  }

  if (emaFast > emaSlow) {
    return 'BUY';
  }

  if (emaFast < emaSlow) {
    return 'SELL';
  }

  return direction || 'UNKNOWN';
}

function getSymbolCooldownMinutes(symbol) {
  const key = String(symbol || '').toUpperCase();
  return Number(config.publicSignals.symbolCooldownMinutes[key] || config.publicSignals.minMinutesBetweenPosts || 30);
}

function summarizeReasoning(signal, evaluation) {
  return evaluation.reasons.slice(0, 3).join(', ');
}

function resolveExecutionTimestamp(executionResult = {}) {
  const dealTime = Number(
    executionResult.orderResult
    && executionResult.orderResult.dealTime,
  );

  if (Number.isFinite(dealTime) && dealTime > 0) {
    return new Date(dealTime * 1000).toISOString();
  }

  return new Date().toISOString();
}

function resolveCloseReason(updateEvent) {
  const actions = Array.isArray(updateEvent.actions) ? updateEvent.actions : [];

  if (actions.includes('sl_hit')) {
    return 'stop_loss';
  }

  if (actions.includes('closed_profit')) {
    return 'take_profit_or_profit_close';
  }

  if (actions.includes('closed_loss')) {
    return 'loss_close';
  }

  if (actions.includes('partial_close')) {
    return 'partial_close';
  }

  if (actions.includes('closed')) {
    return 'closed';
  }

  return actions[0] || '';
}

function computeFallbackClosedPnl(trackedSignal, reconciliation) {
  const entryPrice = Number(
    trackedSignal.execution && trackedSignal.execution.executionPrice != null
      ? trackedSignal.execution.executionPrice
      : trackedSignal.entry,
  );
  const exitPrice = Number(reconciliation && reconciliation.exitPrice);
  const qty = Number(reconciliation && reconciliation.closedQty);
  const direction = String(trackedSignal.direction || trackedSignal.execution && trackedSignal.execution.side || '').toUpperCase();

  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || !Number.isFinite(qty) || qty <= 0) {
    return '';
  }

  const priceMove = direction === 'SELL' ? entryPrice - exitPrice : exitPrice - entryPrice;
  return Number((priceMove * qty).toFixed(2));
}

function logTradeLifecycleEvent(trackedSignal, updateEvent) {
  const timestamp = updateEvent.timestamp || new Date().toISOString();
  const actions = Array.isArray(updateEvent.actions) ? updateEvent.actions : [];

  if (actions.some((action) => ['move_sl_to_breakeven', 'breakeven_moved', 'profit_locked', 'trailing_started', 'trail_stop_advanced'].includes(action))) {
    logTradeEvent({
      timestamp,
      symbol: trackedSignal.symbol,
      event_type: 'position_modified',
      side: trackedSignal.direction,
      qty: trackedSignal.execution && trackedSignal.execution.remainingQty,
      price: updateEvent.reconciliation && updateEvent.reconciliation.exitPrice,
      position: trackedSignal.execution && trackedSignal.execution.remainingQty,
      position_id: updateEvent.reconciliation && updateEvent.reconciliation.positionId,
      order_id: updateEvent.reconciliation && updateEvent.reconciliation.ticket,
      status: trackedSignal.status,
      notes: actions.join('|'),
    });
  }

  if (updateEvent.reconciliation && updateEvent.reconciliation.exitTradeKey) {
    const closedQty = Number(updateEvent.reconciliation.closedQty ?? updateEvent.closedQty);
    logTradeEvent({
      timestamp,
      symbol: trackedSignal.symbol,
      event_type: actions.includes('partial_close') ? 'position_reduced' : 'position_closed',
      side: trackedSignal.direction,
      qty: Number.isFinite(closedQty) ? closedQty : '',
      price: updateEvent.reconciliation.exitPrice,
      position: trackedSignal.execution && trackedSignal.execution.remainingQty,
      position_id: updateEvent.reconciliation.positionId,
      order_id: updateEvent.reconciliation.ticket,
      status: trackedSignal.status,
      notes: `${updateEvent.reconciliation.exitSource || 'reconciliation'}:${resolveCloseReason(updateEvent)}`,
    });
  }
}

function logClosedTradeRow(trackedSignal, updateEvent) {
  const reconciliation = updateEvent.reconciliation;

  if (!reconciliation || !reconciliation.exitTradeKey) {
    return;
  }

  const entryTime = trackedSignal.enteredAt || trackedSignal.timestamp || '';
  const exitTime = updateEvent.timestamp || trackedSignal.updatedAt || '';
  const entryTimeMs = Date.parse(entryTime || 0);
  const exitTimeMs = Date.parse(exitTime || 0);
  const durationSeconds = Number.isFinite(entryTimeMs) && Number.isFinite(exitTimeMs) && exitTimeMs >= entryTimeMs
    ? Math.round((exitTimeMs - entryTimeMs) / 1000)
    : '';
  const risk = trackedSignal.riskLabel || trackedSignal.publicRiskLevel || classifyRiskLevel(trackedSignal).level;
  const pnl = reconciliation.pnl != null && reconciliation.pnl !== ''
    ? reconciliation.pnl
    : computeFallbackClosedPnl(trackedSignal, reconciliation);
  const managementFlags = [];

  if (trackedSignal.breakevenMoved) {
    managementFlags.push('breakeven');
  }

  if (trackedSignal.management && trackedSignal.management.partialTpTaken) {
    managementFlags.push('partial_tp');
  }

  if (trackedSignal.management && trackedSignal.management.trailingStarted) {
    managementFlags.push('trailing');
  }

  logTrade({
    closed_at: exitTime,
    symbol: trackedSignal.symbol || '',
    side: trackedSignal.direction || trackedSignal.execution && trackedSignal.execution.side || '',
    entry_price: trackedSignal.execution && trackedSignal.execution.executionPrice != null
      ? trackedSignal.execution.executionPrice
      : trackedSignal.entry,
    exit_price: reconciliation.exitPrice ?? '',
    qty: reconciliation.closedQty ?? updateEvent.closedQty ?? '',
    pnl,
    pnl_currency: process.env.ACCOUNT_CURRENCY || 'USD',
    trade_duration_seconds: durationSeconds,
    entry_time: entryTime,
    exit_time: exitTime,
    source_type: trackedSignal.sourceType || trackedSignal.sourceLabel || '',
    strategy_name: trackedSignal.strategyName || '',
    risk_label: risk,
    approval_score: trackedSignal.approvalScore ?? trackedSignal.publicScore ?? '',
    ticket: reconciliation.ticket ?? '',
    position_id: reconciliation.positionId ?? '',
    close_event_key: reconciliation.exitTradeKey,
    close_reason: resolveCloseReason(updateEvent),
    stop_loss: trackedSignal.execution && trackedSignal.execution.stopLoss != null
      ? trackedSignal.execution.stopLoss
      : trackedSignal.stopLoss,
    take_profit: trackedSignal.execution && trackedSignal.execution.takeProfit != null
      ? trackedSignal.execution.takeProfit
      : (Array.isArray(trackedSignal.takeProfits) && trackedSignal.takeProfits.length > 0
        ? trackedSignal.takeProfits[trackedSignal.takeProfits.length - 1]
        : ''),
    max_favorable_excursion: trackedSignal.maxFavorableExcursion ?? '',
    max_adverse_excursion: trackedSignal.maxAdverseExcursion ?? '',
    session: trackedSignal.session || '',
    regime: trackedSignal.regime || '',
    publicly_posted: trackedSignal.postedAt ? 'true' : 'false',
    notes: [
      reconciliation.exitSource || 'reconciliation',
      trackedSignal.setupType ? `setupType=${trackedSignal.setupType}` : '',
      managementFlags.length > 0 ? `management=${managementFlags.join('|')}` : '',
      updateEvent.rawText || '',
    ].filter(Boolean).join(' | '),
  });
}

function scorePublicSignalCandidate(signal, queueState) {
  const risk = classifyRiskLevel(signal);
  const rr = Number(risk.rewardRiskRatio || 0);
  const ageMinutes = minutesAgo(signal.timestamp);
  const sessionLabels = getSessionLabels(signal.timestamp || Date.now());
  const indicators = signal.indicators || {};
  const direction = String(signal.direction || signal.side || '').toUpperCase();
  const trendBias = getDirectionalBias(signal);
  const rsi = Number(indicators.rsi);
  const duplicateWindowMinutes = Number(config.publicSignals.duplicateWindowMinutes || 180);
  const recentSimilar = [
    ...(Array.isArray(queueState.candidates) ? queueState.candidates : []),
    ...(Array.isArray(queueState.postHistory) ? queueState.postHistory : []),
  ].filter((candidate) => {
    return String(candidate.symbol || '').toUpperCase() === String(signal.symbol || '').toUpperCase()
      && String(candidate.direction || '').toUpperCase() === direction
      && minutesAgo(candidate.timestamp || candidate.postedAt || candidate.queuedAt) <= duplicateWindowMinutes;
  });

  let score = Number(risk.score || 0);
  const reasons = [...(risk.reasons || [])];
  const penalties = [];

  if (risk.level === 'Low') {
    score += 14;
    reasons.push('low_risk_setup');
  } else if (risk.level === 'Medium') {
    score += 2;
    reasons.push('medium_risk_setup');
  } else {
    score -= 20;
    penalties.push('high_risk_setup');
  }

  if (rr >= 2) {
    score += 18;
    reasons.push('strong_rr');
  } else if (rr >= 1.6) {
    score += 10;
    reasons.push('good_rr');
  } else if (rr < 1.3) {
    score -= 12;
    penalties.push('weak_rr');
  }

  if (sessionLabels.some((label) => ['LONDON', 'NEWYORK'].includes(label))) {
    score += 8;
    reasons.push(`session_${sessionLabels.join('_').toLowerCase()}`);
  } else {
    score -= 8;
    penalties.push('off_session');
  }

  if (trendBias === direction) {
    score += 12;
    reasons.push('trend_aligned');
  } else if (trendBias !== 'UNKNOWN') {
    score -= 14;
    penalties.push('trend_conflict');
  }

  if (Number.isFinite(rsi)) {
    if ((direction === 'BUY' && rsi >= 48 && rsi <= 68) || (direction === 'SELL' && rsi >= 32 && rsi <= 52)) {
      score += 6;
      reasons.push('momentum_supported');
    } else {
      score -= 6;
      penalties.push('momentum_marginal');
    }
  }

  if (signal.newsAnalysis && signal.newsAnalysis.pairBias) {
    const confidence = Number(signal.newsAnalysis.pairBias.confidence || 0);
    const relevance = Number(signal.newsAnalysis.pairBias.relevanceScore || 0);
    score += Math.round(confidence * 15 + relevance * 10);
    reasons.push('news_confirmed');
  }

  if (signal.strategyName) {
    score += 8;
    reasons.push(`strategy_${String(signal.strategyName).toLowerCase()}`);
  }

  if (ageMinutes > Number(config.publicSignals.staleAfterMinutes || 90)) {
    penalties.push('stale_signal');
    score -= 30;
  } else if (ageMinutes > Math.floor(Number(config.publicSignals.staleAfterMinutes || 90) * 0.5)) {
    penalties.push('aging_signal');
    score -= 8;
  } else {
    reasons.push('fresh_signal');
  }

  if (recentSimilar.length > 0) {
    score -= 10 + Math.min(10, recentSimilar.length * 3);
    penalties.push('recent_similar_signal');
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  const confidence = normalizedScore >= 82 ? 'High' : normalizedScore >= 68 ? 'Medium' : 'Low';
  let decision = 'REJECT';

  if (risk.level === 'High' && !config.publicSignals.highRiskPostable) {
    penalties.push('high_risk_not_postable');
  } else if (risk.level === 'Medium' && !config.publicSignals.mediumRiskPostable) {
    penalties.push('medium_risk_not_postable');
  } else if (
    risk.level === 'Medium'
    && normalizedScore < Number(config.publicSignals.mediumRiskMinPostingScore || 72)
  ) {
    penalties.push('medium_risk_score_too_low');
  }

  if (penalties.includes('stale_signal')) {
    decision = 'REJECT';
  } else if (normalizedScore >= Number(config.publicSignals.minApproveScore || 60) && penalties.length === 0) {
    decision = 'APPROVE';
  } else if (
    normalizedScore >= Number(config.publicSignals.minApproveScore || 60)
    && penalties.every((entry) => !['high_risk_not_postable', 'medium_risk_not_postable', 'medium_risk_score_too_low', 'stale_signal'].includes(entry))
  ) {
    decision = 'APPROVE';
  }

  return {
    score: normalizedScore,
    confidence,
    risk,
    reasons,
    penalties,
    sessionLabels,
    ageMinutes: Number(ageMinutes.toFixed(1)),
    decision,
  };
}

function pruneQueueState(state) {
  const staleAfterMinutes = Number(config.publicSignals.staleAfterMinutes || 90);
  const retainedCandidates = [];

  for (const candidate of state.candidates || []) {
    if (minutesAgo(candidate.timestamp || candidate.queuedAt) > staleAfterMinutes) {
      recordAnalytics(state, candidate, 'dropped', 1);
      markSignalStatus(candidate.id, 'dropped', 'Candidate expired before posting', {
        timestamp: new Date().toISOString(),
      }, {
        droppedReason: 'stale',
      });
      logDecision({
        type: 'candidate_dropped',
        symbol: candidate.symbol,
        signalId: candidate.id,
        sourceType: candidate.source || candidate.strategyName || 'internal',
        decision: 'DROP',
        score: candidate.publicScore,
        reasons: ['stale'],
      });
      continue;
    }

    retainedCandidates.push(candidate);
  }

  state.candidates = retainedCandidates;
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  state.postHistory = (state.postHistory || []).filter((entry) => Date.parse(entry.postedAt || 0) >= oneDayAgo);
}

async function postSignalNow(signal, trackedSignal) {
  const caption = formatSignalMessage(signal);
  const card = await safeGenerateCard(generateSignalCard, 'Signal card', signal);
  const publishResult = await postToChannel({
    caption,
    imageBuffer: card && card.buffer,
    filename: `${signal.symbol || 'signal'}-signal.png`,
  });

  if (publishResult) {
    markSignalPosted(trackedSignal.id, publishResult);
  }

  return publishResult;
}

async function processQueuedSignals() {
  if (!config.publicSignals.enabled || !isPublishingConfigured()) {
    return null;
  }

  const state = readQueueState();
  pruneQueueState(state);

  if (!Array.isArray(state.candidates) || state.candidates.length === 0) {
    writeQueueState(state);
    return null;
  }

  const now = Date.now();
  const postsLastHour = (state.postHistory || []).filter((entry) => now - Date.parse(entry.postedAt || 0) < 60 * 60 * 1000);

  if (postsLastHour.length >= Number(config.publicSignals.maxPostsPerHour || 2)) {
    writeQueueState(state);
    return null;
  }

  const latestPost = postsLastHour.sort((left, right) => Date.parse(right.postedAt || 0) - Date.parse(left.postedAt || 0))[0];
  if (latestPost && minutesAgo(latestPost.postedAt) < Number(config.publicSignals.minMinutesBetweenPosts || 30)) {
    writeQueueState(state);
    return null;
  }

  const ranked = [...state.candidates].sort((left, right) => {
    if (right.publicScore !== left.publicScore) {
      return right.publicScore - left.publicScore;
    }

    return Date.parse(left.timestamp || left.queuedAt || 0) - Date.parse(right.timestamp || right.queuedAt || 0);
  });

  const nextCandidate = ranked.find((candidate) => {
    const cooldownMinutes = getSymbolCooldownMinutes(candidate.symbol);
    const latestForSymbol = (state.postHistory || [])
      .filter((entry) => String(entry.symbol || '').toUpperCase() === String(candidate.symbol || '').toUpperCase())
      .sort((left, right) => Date.parse(right.postedAt || 0) - Date.parse(left.postedAt || 0))[0];

    return !latestForSymbol || minutesAgo(latestForSymbol.postedAt) >= cooldownMinutes;
  });

  if (!nextCandidate) {
    writeQueueState(state);
    return null;
  }

  if (Number.isFinite(Number(nextCandidate.entry)) && Number(config.publicSignals.maxEntryDeviationPct || 0) > 0) {
    const profile = (config.profiles || []).find((entry) => String(entry.symbol || '').toUpperCase() === String(nextCandidate.symbol || '').toUpperCase());

    if (profile) {
      try {
        const latestPrice = await getLatestPrice(profile);
        const entryDeviationPct = latestPrice > 0
          ? Math.abs(latestPrice - Number(nextCandidate.entry)) / latestPrice
          : 0;

        if (entryDeviationPct > Number(config.publicSignals.maxEntryDeviationPct || 0.0015)) {
          state.candidates = state.candidates.filter((candidate) => candidate.id !== nextCandidate.id);
          recordAnalytics(state, nextCandidate, 'dropped', 1);
          markSignalStatus(nextCandidate.id, 'dropped', 'Candidate dropped because price moved too far from entry', {
            timestamp: new Date().toISOString(),
          }, {
            droppedReason: 'entry_deviation',
          });
          logDecision({
            type: 'candidate_dropped',
            symbol: nextCandidate.symbol,
            signalId: nextCandidate.id,
            sourceType: nextCandidate.source || nextCandidate.strategyName || 'internal',
            decision: 'DROP',
            score: nextCandidate.publicScore,
            reasons: ['entry_deviation'],
            context: {
              latestPrice,
              entry: nextCandidate.entry,
              entryDeviationPct,
            },
          });
          writeQueueState(state);
          return null;
        }
      } catch (err) {
        log(`[TELEGRAM_POST] Freshness recheck failed for ${nextCandidate.symbol}: ${err.message}`);
      }
    }
  }

  const trackedSignal = upsertSignalRecord(nextCandidate);

  try {
    const publishResult = await postSignalNow(nextCandidate, trackedSignal);
    recordAnalytics(state, nextCandidate, 'posted', 1);
    state.analytics.postedScores.push(Number(nextCandidate.publicScore || 0));
    state.postHistory.push({
      id: nextCandidate.id,
      symbol: nextCandidate.symbol,
      direction: nextCandidate.direction,
      riskLevel: nextCandidate.riskLevel,
      publicScore: nextCandidate.publicScore,
      postedAt: publishResult && publishResult.timestamp ? publishResult.timestamp : new Date().toISOString(),
    });
    state.candidates = state.candidates.filter((candidate) => candidate.id !== nextCandidate.id);
    markSignalStatus(nextCandidate.id, 'posted', 'Candidate posted to Telegram channel', {
      timestamp: new Date().toISOString(),
    }, {
      publicScore: nextCandidate.publicScore,
      publicRiskLevel: nextCandidate.riskLevel,
    });
    logDecision({
      type: 'candidate_posted',
      symbol: nextCandidate.symbol,
      signalId: nextCandidate.id,
      sourceType: nextCandidate.source || nextCandidate.strategyName || 'internal',
      decision: 'POSTED',
      score: nextCandidate.publicScore,
      reasons: nextCandidate.publicReasons || [],
    });
    writeQueueState(state);
    return nextCandidate;
  } catch (err) {
    markSignalPostFailed(nextCandidate.id, err.message);
    writeQueueState(state);
    throw err;
  }
}

function isPublishingConfigured() {
  return getPostingConfig().enabled;
}

function shouldPublishSourceSignal(signal) {
  const symbol = String(signal && signal.symbol || '').toUpperCase();
  const sourceType = String(signal && (signal.sourceType || signal.source || '') || '').toUpperCase();
  const strategyName = String(signal && signal.strategyName || '').toLowerCase();
  const approvalScore = Number(signal && signal.approvalScore);
  const riskLabel = String(signal && (signal.riskLabel || signal.riskLevel || '') || '').toUpperCase();
  const session = String(signal && signal.session || '').toUpperCase();
  const isPreferredSession = session.includes('LONDON') || session.includes('NEWYORK');
  const takeProfits = Array.isArray(signal && signal.takeProfits) ? signal.takeProfits.filter((value) => Number.isFinite(Number(value))) : [];
  const hasLayeredTargets = takeProfits.length >= 3;
  const bypassPublishLearningGate = symbol === 'EURUSD'
    && sourceType === 'STRATEGY'
    && strategyName === 'bias'
    && Number.isFinite(approvalScore)
    && approvalScore >= 90
    && isPreferredSession
    && (riskLabel !== 'HIGH' || hasLayeredTargets);

  if (config.learning.enabled) {
    const learningAssessment = getLearningAssessmentForSignal(signal, {
      lookbackDays: config.learning.lookbackDays,
      minSettledSignals: config.learning.minSettledSignals,
    });

    if (
      !bypassPublishLearningGate &&
      Number.isFinite(config.learning.minScoreToPublish) &&
      learningAssessment.hasEnoughData &&
      Number.isFinite(learningAssessment.aggregateScore) &&
      learningAssessment.aggregateScore < config.learning.minScoreToPublish
    ) {
      return {
        allowed: false,
        sourceStats: null,
        learningAssessment,
      };
    }
  }

  const minWinRateToPublish = config.sourcePerformance.minWinRateToPublish;

  if (!Number.isFinite(minWinRateToPublish)) {
    return {
      allowed: true,
      sourceStats: null,
      learningAssessment: null,
    };
  }

  const sourceStats = getSourcePerformanceForSignal(signal, {
    lookbackDays: config.sourcePerformance.lookbackDays,
    minSettledSignals: config.sourcePerformance.minSettledSignals,
  });

  if (!sourceStats) {
    return {
      allowed: true,
      sourceStats: null,
      learningAssessment: null,
    };
  }

  if (sourceStats.settledSignals < config.sourcePerformance.minSettledSignals) {
    return {
      allowed: true,
      sourceStats,
      learningAssessment: null,
    };
  }

  return {
    allowed: sourceStats.winRate >= minWinRateToPublish,
    sourceStats,
    learningAssessment: null,
  };
}

async function safeGenerateCard(generator, label, payload) {
  try {
    return await generator(payload);
  } catch (err) {
    log(`[IMAGES] ${label} generation failed: ${err.message}`);
    return null;
  }
}

async function publishSignal(signal, executionResult = {}) {
  const initialRisk = classifyRiskLevel(signal);
  const trackedSignal = upsertSignalRecord({
    ...signal,
    sourceType: signal.sourceType || signal.source || '',
    riskLabel: signal.riskLabel || signal.riskLevel || initialRisk.level,
  });
  markSignalStatus(trackedSignal.id, 'candidate', 'Signal candidate created for public ranking', {
    timestamp: new Date().toISOString(),
  });
  const publishDecision = shouldPublishSourceSignal(trackedSignal);
  const queueState = readQueueState();
  pruneQueueState(queueState);
  recordAnalytics(queueState, trackedSignal, 'created', 1);

  if (!publishDecision.allowed) {
    if (publishDecision.learningAssessment) {
      log(
        `[TELEGRAM_POST] Skipping publish for ${trackedSignal.symbol}: learned score `
        + `${publishDecision.learningAssessment.aggregateScore} is below the publish threshold `
        + `(${config.learning.minScoreToPublish})`,
      );
    } else {
    log(
      `[TELEGRAM_POST] Skipping publish for ${trackedSignal.symbol}: source ${trackedSignal.sourceLabel || trackedSignal.sourceChannelName || trackedSignal.sourceChannelId} `
      + `is below the configured threshold (${publishDecision.sourceStats.winRate}% < ${config.sourcePerformance.minWinRateToPublish}%)`,
    );
    }

    if (executionResult.executed) {
      const executionTimestamp = resolveExecutionTimestamp(executionResult);
      markSignalEntered(trackedSignal.id, {
        timestamp: executionTimestamp,
        executionPrice: executionResult.executionPrice,
        qty: executionResult.qty,
        remainingQty: executionResult.qty,
        orderId: executionResult.orderResult && (executionResult.orderResult.orderId ?? executionResult.orderResult.ticket),
        positionId: executionResult.orderResult && (executionResult.orderResult.positionId ?? null),
        stopLoss: executionResult.stopLoss,
        takeProfit: executionResult.takeProfit,
        brokerStatus: executionResult.orderResult && executionResult.orderResult.status,
        side: signal.direction,
      });
    }

    recordAnalytics(queueState, trackedSignal, 'rejected', 1);
    markSignalStatus(trackedSignal.id, 'rejected', 'Rejected by source/learning gate before queueing', {
      timestamp: new Date().toISOString(),
    });
    logDecision({
      type: 'candidate_rejected',
      symbol: trackedSignal.symbol,
      signalId: trackedSignal.id,
      sourceType: trackedSignal.sourceLabel || trackedSignal.sourceChannelName || trackedSignal.sourceChannelId || 'internal',
      decision: 'REJECT',
      reasons: ['source_or_learning_gate'],
    });
    writeQueueState(queueState);
    return trackedSignal;
  }

  if (executionResult.executed) {
    const executionTimestamp = resolveExecutionTimestamp(executionResult);
    markSignalEntered(trackedSignal.id, {
      timestamp: executionTimestamp,
      executionPrice: executionResult.executionPrice,
      qty: executionResult.qty,
      remainingQty: executionResult.qty,
      orderId: executionResult.orderResult && (executionResult.orderResult.orderId ?? executionResult.orderResult.ticket),
      positionId: executionResult.orderResult && (executionResult.orderResult.positionId ?? null),
      stopLoss: executionResult.stopLoss,
      takeProfit: executionResult.takeProfit,
      brokerStatus: executionResult.orderResult && executionResult.orderResult.status,
      side: signal.direction,
    });
  }

  const evaluation = scorePublicSignalCandidate(trackedSignal, queueState);
  const enrichedSignal = {
    ...trackedSignal,
    publicScore: evaluation.score,
    publicConfidence: evaluation.confidence,
    publicReasons: evaluation.reasons,
    publicPenalties: evaluation.penalties,
    score: evaluation.score,
    riskLevel: evaluation.risk.level,
    riskScore: evaluation.risk.score,
    reasoningSummary: summarizeReasoning(trackedSignal, evaluation),
  };

  logDecision({
    type: 'candidate_created',
    symbol: trackedSignal.symbol,
    signalId: trackedSignal.id,
    sourceType: trackedSignal.sourceLabel || trackedSignal.sourceChannelName || trackedSignal.sourceChannelId || 'internal',
    decision: evaluation.decision,
    score: evaluation.score,
    reasons: [...evaluation.reasons, ...evaluation.penalties],
    context: {
      riskLevel: evaluation.risk.level,
      riskScore: evaluation.risk.score,
      rewardRiskRatio: evaluation.risk.rewardRiskRatio,
      ageMinutes: evaluation.ageMinutes,
      sessionLabels: evaluation.sessionLabels,
    },
  });

  if (evaluation.decision !== 'APPROVE') {
    recordAnalytics(queueState, trackedSignal, 'rejected', 1);
    markSignalStatus(trackedSignal.id, 'rejected', 'Candidate rejected by public scoring', {
      timestamp: new Date().toISOString(),
    }, {
      publicScore: evaluation.score,
      publicRiskLevel: evaluation.risk.level,
      rejectionReasons: evaluation.penalties,
    });
    log(`[TELEGRAM_POST] Rejected ${trackedSignal.symbol} ${trackedSignal.direction}: ${[...evaluation.reasons, ...evaluation.penalties].join(', ')}`);
    writeQueueState(queueState);
    return enrichedSignal;
  }

  recordAnalytics(queueState, enrichedSignal, 'approved', 1);
  markSignalStatus(trackedSignal.id, 'approved', 'Candidate approved for rolling Telegram queue', {
    timestamp: new Date().toISOString(),
  }, {
    publicScore: evaluation.score,
    publicRiskLevel: evaluation.risk.level,
    publicConfidence: evaluation.confidence,
  });

  const duplicateIndex = queueState.candidates.findIndex((candidate) => {
    return String(candidate.symbol || '').toUpperCase() === String(enrichedSignal.symbol || '').toUpperCase()
      && String(candidate.direction || '').toUpperCase() === String(enrichedSignal.direction || '').toUpperCase();
  });

  if (duplicateIndex >= 0) {
    const existing = queueState.candidates[duplicateIndex];
    const minImprovement = Number(config.publicSignals.minScoreImprovementForDuplicate || 8);

    if (evaluation.score >= Number(existing.publicScore || 0) + minImprovement) {
      markSignalStatus(existing.id, 'dropped', 'Superseded by materially stronger candidate', {
        timestamp: new Date().toISOString(),
      }, {
        droppedReason: 'superseded',
      });
      recordAnalytics(queueState, existing, 'dropped', 1);
      queueState.candidates.splice(duplicateIndex, 1, {
        ...enrichedSignal,
        queuedAt: new Date().toISOString(),
      });
    } else {
      recordAnalytics(queueState, trackedSignal, 'rejected', 1);
      markSignalStatus(trackedSignal.id, 'dropped', 'Near-duplicate candidate weaker than queued signal', {
        timestamp: new Date().toISOString(),
      }, {
        droppedReason: 'duplicate_weaker',
      });
      logDecision({
        type: 'candidate_dropped',
        symbol: trackedSignal.symbol,
        signalId: trackedSignal.id,
        sourceType: trackedSignal.sourceLabel || trackedSignal.sourceChannelName || trackedSignal.sourceChannelId || 'internal',
        decision: 'DROP',
        score: evaluation.score,
        reasons: ['duplicate_weaker_than_queued'],
      });
      writeQueueState(queueState);
      return enrichedSignal;
    }
  } else {
    recordAnalytics(queueState, enrichedSignal, 'queued', 1);
    queueState.candidates.push({
      ...enrichedSignal,
      queuedAt: new Date().toISOString(),
    });
  }

  markSignalStatus(trackedSignal.id, 'queued', 'Candidate queued for paced Telegram posting', {
    timestamp: new Date().toISOString(),
  }, {
    publicScore: evaluation.score,
    publicRiskLevel: evaluation.risk.level,
    publicConfidence: evaluation.confidence,
  });
  logDecision({
    type: 'candidate_queued',
    symbol: trackedSignal.symbol,
    signalId: trackedSignal.id,
    sourceType: trackedSignal.sourceLabel || trackedSignal.sourceChannelName || trackedSignal.sourceChannelId || 'internal',
    decision: 'QUEUE',
    score: evaluation.score,
    reasons: evaluation.reasons,
    context: {
      riskLevel: evaluation.risk.level,
      confidence: evaluation.confidence,
    },
  });
  writeQueueState(queueState);

  if (isPublishingConfigured()) {
    try {
      await processQueuedSignals();
    } catch (err) {
      log(`[TELEGRAM_POST] Rolling queue processing failed: ${err.message}`);
    }
  }

  return upsertSignalRecord(signal);
}

async function publishTradeUpdate(updateEvent) {
  const trackedSignal = applyTradeUpdate(updateEvent);

  if (!trackedSignal) {
    return null;
  }

  logTradeLifecycleEvent(trackedSignal, updateEvent);
  logClosedTradeRow(trackedSignal, updateEvent);

  if (!isPublishingConfigured()) {
    return trackedSignal;
  }

  const caption = formatTradeUpdateMessage(trackedSignal, updateEvent);
  const card = await safeGenerateCard(
    (payload) => generateResultCard(payload.signal, payload.updateEvent),
    'Result card',
    { signal: trackedSignal, updateEvent },
  );

  try {
    await postToChannel({
      caption,
      imageBuffer: card && card.buffer,
      filename: `${trackedSignal.symbol || 'signal'}-update.png`,
    });
  } catch (err) {
    log(`[TELEGRAM_POST] Trade update publish failed: ${err.message}`);
  }

  return trackedSignal;
}

async function publishWeeklySummaryReport(report) {
  const caption = formatWeeklySummary(report);

  if (!isPublishingConfigured()) {
    return {
      caption,
      posted: false,
    };
  }

  const card = await safeGenerateCard(generateWeeklyReportCard, 'Weekly report card', report);
  try {
    const publishResult = await postToChannel({
      caption,
      imageBuffer: card && card.buffer,
      filename: 'weekly-report.png',
      preferText: caption.length > 900,
    });

    return {
      caption,
      posted: Boolean(publishResult),
      publishResult,
    };
  } catch (err) {
    log(`[TELEGRAM_POST] Weekly summary publish failed: ${err.message}`);
    return {
      caption,
      posted: false,
    };
  }
}

async function publishDailySummaryReport(report) {
  const caption = formatDailySummary(report);

  if (!isPublishingConfigured()) {
    return {
      caption,
      posted: false,
    };
  }

  try {
    const publishResult = await postToChannel({
      caption,
      preferText: true,
    });

    return {
      caption,
      posted: Boolean(publishResult),
      publishResult,
    };
  } catch (err) {
    log(`[TELEGRAM_POST] Daily summary publish failed: ${err.message}`);
    return {
      caption,
      posted: false,
    };
  }
}

module.exports = {
  processQueuedSignals,
  isPublishingConfigured,
  publishSignal,
  publishDailySummaryReport,
  publishTradeUpdate,
  publishWeeklySummaryReport,
};
