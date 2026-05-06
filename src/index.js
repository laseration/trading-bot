const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log, logDecision } = require('./logger');
const { prepareBotRun, runBot } = require('./bot');
const { getRecentSignalConfluence, pollTelegramSignals } = require('./telegram');
const { pollNewsSignals } = require('./newsAnalyzer');
const { getLatestMt5Quote } = require('./mt5Bridge');
const { ensureMt5RuntimeReady, fetchBridgeHealthWithRetries } = require('./mt5Startup');
const { runStartupCleanup } = require('./startupRecovery');
const { evaluateHybridDecision } = require('./hybridDecision');
const { reconcileSignalResults } = require('./signals/reconcileSignalResults');
const { manageLiveTrades } = require('./signals/liveTradeManager');
const { aggregateDailyPerformance, getLearningAssessmentForSignal } = require('./signals/performanceAggregator');
const {
  isPublishingConfigured,
  processQueuedSignals,
  publishDailySummaryReport,
  publishSignal,
  publishTradeUpdate,
} = require('./telegram/publishingService');
const { logEurUsdBiasDiagnostics } = require('./logger');

const INTERVAL_MS = config.intervalMs;
const runtimeDir = path.join(__dirname, '..', 'runtime');
const botLockPath = path.join(runtimeDir, 'bot.lock.json');
const dailySummaryStatePath = path.join(runtimeDir, 'daily-summary-state.json');
const PROFILES = config.profiles && config.profiles.length > 0
  ? config.profiles
  : (config.symbols || ['NVDA']).map((symbol) => ({
      symbol,
      market: symbol.includes('/') ? 'crypto' : 'stock',
      dataSource: 'alpaca',
      signalSource: 'strategy',
      broker: config.paperTradingMode ? 'paper' : 'alpaca',
    }));
const strategyProfiles = PROFILES.filter((profile) => profile.signalSource !== 'telegram');
const telegramProfiles = PROFILES.filter((profile) => profile.signalSource === 'telegram');
const executionProfilesBySymbol = new Map();

for (const profile of PROFILES) {
  const key = String(profile.symbol || '').toUpperCase();

  if (key && !executionProfilesBySymbol.has(key)) {
    executionProfilesBySymbol.set(key, profile);
  }
}

function isEurUsdBiasCandidate(candidate = {}, symbol = '') {
  return String(symbol || candidate.symbol || '').toUpperCase() === 'EURUSD'
    && String(candidate.strategyName || '').toLowerCase() === 'bias';
}

function buildEurUsdBiasEntryZone(entry) {
  const numericEntry = Number(entry);

  if (!Number.isFinite(numericEntry) || numericEntry <= 0) {
    return null;
  }

  return Number((Math.round(numericEntry / 0.0005) * 0.0005).toFixed(5));
}

function buildEurUsdBiasDiagnosticEvent({
  stage,
  profile,
  candidate = {},
  hybridDecision = null,
  executionResult = null,
}) {
  const indicators = candidate.indicators && typeof candidate.indicators === 'object' ? candidate.indicators : {};
  const marketContext = hybridDecision && hybridDecision.context && hybridDecision.context.marketContext
    ? hybridDecision.context.marketContext
    : null;
  const sessionLabels = marketContext && Array.isArray(marketContext.sessionLabels)
    ? marketContext.sessionLabels.join('|')
    : (candidate.session || '');
  const primaryTakeProfit = Array.isArray(candidate.takeProfits) && candidate.takeProfits.length > 0
    ? candidate.takeProfits[candidate.takeProfits.length - 1]
    : null;
  const continuationCheck = String(candidate.direction || '').toUpperCase() === 'SELL'
    ? indicators.continuationShort
    : indicators.continuationLong;
  const structureCheck = String(candidate.direction || '').toUpperCase() === 'SELL'
    ? indicators.shortStructureOk
    : indicators.longStructureOk;
  const orderResult = executionResult && executionResult.orderResult ? executionResult.orderResult : null;
  const entryZone = buildEurUsdBiasEntryZone(candidate.entry);
  const thesisKey = [
    String(profile && profile.symbol || candidate.symbol || '').toUpperCase(),
    candidate.direction || candidate.side || candidate.signal || '',
    marketContext && marketContext.regime ? marketContext.regime : (candidate.regime || ''),
    candidate.biasStrength || '',
    entryZone != null ? entryZone.toFixed(5) : 'na',
  ].join('|');

  return {
    eventType: 'eurusd_bias_diagnostics',
    stage,
    signalId: candidate.id || '',
    timestamp: candidate.timestamp || new Date().toISOString(),
    symbol: String(profile && profile.symbol || candidate.symbol || '').toUpperCase(),
    strategyName: candidate.strategyName || '',
    regime: marketContext && marketContext.regime ? marketContext.regime : (candidate.regime || ''),
    session: sessionLabels,
    direction: candidate.direction || candidate.side || candidate.signal || '',
    decision: stage === 'execution'
      ? (executionResult && executionResult.executed ? 'EXECUTED' : executionResult && executionResult.action || 'execution_skipped')
      : (candidate.direction === 'HOLD' ? 'HOLD' : hybridDecision && hybridDecision.decision || 'UNKNOWN'),
    approvalScore: hybridDecision ? hybridDecision.score : (candidate.approvalScore ?? null),
    biasDirection: candidate.biasDirection || '',
    biasStrength: candidate.biasStrength || '',
    entryZone,
    thesisKey,
    entry: candidate.entry ?? null,
    stopLoss: candidate.stopLoss ?? null,
    takeProfit: primaryTakeProfit,
    emaFast: indicators.emaFast ?? null,
    emaSlow: indicators.emaSlow ?? null,
    emaSeparationAtr: indicators.emaSeparationAtr ?? null,
    rsi: indicators.rsi ?? null,
    atr: indicators.atr ?? null,
    latestBodyAtr: indicators.latestBodyAtr ?? null,
    latestRangeAtr: indicators.latestRangeAtr ?? null,
    emaVelocityAtr: indicators.emaVelocityAtr ?? null,
    pullbackDistanceAtr: indicators.distanceAtr ?? null,
    pullbackOk: indicators.pullbackOk ?? null,
    continuationCheck: continuationCheck ?? null,
    structureCheck: structureCheck ?? null,
    strategyReasons: Array.isArray(candidate.strategyReasons) ? candidate.strategyReasons : [],
    hybridDecisionReasons: hybridDecision ? hybridDecision.reasons : [],
    hybridDecisionBlocks: hybridDecision ? hybridDecision.blocks : [],
    fillPrice: executionResult ? executionResult.executionPrice ?? null : null,
    ticket: orderResult ? orderResult.ticket ?? orderResult.orderId ?? null : null,
    positionId: orderResult ? orderResult.positionId ?? null : null,
    action: executionResult ? executionResult.action : null,
    executed: executionResult ? executionResult.executed : null,
  };
}

function buildGateSnapshot(candidate = {}, hybridDecision = {}, profile = {}) {
  const context = hybridDecision && hybridDecision.context && typeof hybridDecision.context === 'object'
    ? hybridDecision.context
    : {};
  const marketContext = context.marketContext && typeof context.marketContext === 'object'
    ? context.marketContext
    : {};
  const spread = context.spread && typeof context.spread === 'object' ? context.spread : {};
  const indicators = candidate.indicators && typeof candidate.indicators === 'object' ? candidate.indicators : {};
  const triggerCandle = indicators.triggerCandle && typeof indicators.triggerCandle === 'object' ? indicators.triggerCandle : {};
  const h1Bias = indicators.h1Bias && typeof indicators.h1Bias === 'object' ? indicators.h1Bias : {};
  const direction = String(candidate.direction || candidate.side || candidate.signal || '').toUpperCase();
  const triggerConfirmed = direction === 'BUY'
    ? Boolean(triggerCandle.longConfirmed)
    : direction === 'SELL'
      ? Boolean(triggerCandle.shortConfirmed)
      : false;
  const h1Aligned = (String(h1Bias.direction || '').toUpperCase() === direction);
  const session = Array.isArray(marketContext.sessionLabels)
    ? marketContext.sessionLabels.join('|')
    : (candidate.session || '');

  return {
    symbol: String(profile.symbol || candidate.symbol || '').toUpperCase(),
    strategyName: candidate.strategyName || profile.strategyName || '',
    setupType: candidate.setupType || 'UNKNOWN',
    regime: marketContext.regime || candidate.regime || 'UNKNOWN',
    session,
    rrTp1: Number.isFinite(Number(hybridDecision.rrTp1)) ? Number(hybridDecision.rrTp1) : (Number.isFinite(Number(candidate.rrTp1)) ? Number(candidate.rrTp1) : null),
    rrFinal: Number.isFinite(Number(hybridDecision.rrFinal)) ? Number(hybridDecision.rrFinal) : (Number.isFinite(Number(candidate.rrFinal)) ? Number(candidate.rrFinal) : null),
    spread: Number.isFinite(Number(spread.spreadPct)) ? Number(spread.spreadPct) : null,
    h1Aligned,
    triggerConfirmed,
    priceStretch: {
      tooStretched: Array.isArray(candidate.strategyReasons) && candidate.strategyReasons.includes('price_too_stretched'),
      slightlyStretched: Array.isArray(candidate.strategyReasons) && candidate.strategyReasons.includes('price_slightly_stretched'),
    },
    failedZoneActive: Boolean(candidate.recentFailedZone && candidate.recentFailedZone.active),
    blocks: Array.isArray(hybridDecision.blocks) ? hybridDecision.blocks : [],
    reasons: Array.isArray(hybridDecision.reasons) ? hybridDecision.reasons : [],
  };
}

function profileUsesMt5(profile) {
  return profile.dataSource === 'mt5' || (!config.paperTradingMode && profile.broker === 'mt5');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = seconds / 60;

  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }

  return `${(minutes / 60).toFixed(1)}h`;
}

function describeQuoteAge(quoteAgeMs, futureSkewMs) {
  if (Number.isFinite(futureSkewMs) && futureSkewMs > 0) {
    return `${formatDuration(quoteAgeMs)} (broker clock ahead by ${formatDuration(futureSkewMs)})`;
  }

  return formatDuration(quoteAgeMs);
}

function readDailySummaryState() {
  try {
    const raw = fs.readFileSync(dailySummaryStatePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

function writeDailySummaryState(state) {
  fs.mkdirSync(path.dirname(dailySummaryStatePath), { recursive: true });
  fs.writeFileSync(dailySummaryStatePath, JSON.stringify(state, null, 2));
}

async function runStartupChecks() {
  const errors = [];
  const mt5Profiles = PROFILES.filter(profileUsesMt5);

  if (PROFILES.length === 0) {
    errors.push('No profiles are configured');
  }

  if (telegramProfiles.length > 0 && !config.telegram.enabled) {
    errors.push('Telegram signal profiles are configured but TELEGRAM_ENABLED is not true');
  }

  if (config.telegram.enabled) {
    if (!config.telegram.botToken) {
      errors.push('Telegram polling is enabled but TELEGRAM_BOT_TOKEN is missing');
    }

    if (!config.telegram.chatId) {
      errors.push('Telegram polling is enabled but TELEGRAM_SIGNAL_CHAT_ID is missing');
    }
  }

  if (config.news.enabled && !config.news.apiKey && !config.news.alphaVantageApiKey) {
    errors.push('News trading is enabled but no NEWS_API_KEY or ALPHA_VANTAGE_API_KEY is configured');
  }

  if (mt5Profiles.length > 0) {
    if (!config.mt5Bridge.enabled) {
      errors.push('MT5 is required by the active profiles but MT5_BRIDGE_ENABLED is not true');
    } else {
      try {
        const health = await fetchBridgeHealthWithRetries({
          label: 'Startup MT5 bridge health',
          requireConnected: config.mt5Bridge.requireConnected,
        });
        log(`MT5 bridge health: ${health.status || 'ok'}`);

        if (config.mt5Bridge.requireConnected && health.connected !== true) {
          errors.push('HTTP bridge alive but MT5 terminal disconnected from the broker feed');
        }

        const quoteSymbols = [...new Set(mt5Profiles.map((profile) => profile.symbol).filter(Boolean))];

        for (const symbol of quoteSymbols) {
          const quote = await runStartupRequestWithRetries(
            `Startup MT5 quote ${symbol}`,
            () => getLatestMt5Quote(symbol),
          );
          const quoteEpochSeconds = Number(quote.time);

          if (!Number.isFinite(quoteEpochSeconds) || quoteEpochSeconds <= 0) {
            errors.push(`MT5 quote missing for ${symbol}: broker timestamp is absent or invalid`);
            continue;
          }

          const quoteTimestampMs = quoteEpochSeconds * 1000;
          const rawQuoteAgeMs = Date.now() - quoteTimestampMs;
          const futureSkewMs = Math.max(0, quoteTimestampMs - Date.now());
          const quoteAgeMs = Math.max(0, rawQuoteAgeMs);

          log(`[${symbol}] MT5 quote age: ${describeQuoteAge(quoteAgeMs, futureSkewMs)}`);

          if (
            Number.isFinite(config.mt5Bridge.maxFutureQuoteSkewMs) &&
            config.mt5Bridge.maxFutureQuoteSkewMs > 0 &&
            futureSkewMs > config.mt5Bridge.maxFutureQuoteSkewMs
          ) {
            errors.push(
              `MT5 quote for ${symbol} is too far in the future (${formatDuration(futureSkewMs)} ahead, limit ${formatDuration(config.mt5Bridge.maxFutureQuoteSkewMs)})`,
            );
            continue;
          }

          if (
            Number.isFinite(config.mt5Bridge.maxQuoteAgeMs) &&
            config.mt5Bridge.maxQuoteAgeMs > 0 &&
            quoteAgeMs > config.mt5Bridge.maxQuoteAgeMs
          ) {
            errors.push(
              `MT5 quote for ${symbol} is stale (${formatDuration(quoteAgeMs)} old, limit ${formatDuration(config.mt5Bridge.maxQuoteAgeMs)})`,
            );
          }
        }
      } catch (err) {
        errors.push(`MT5 startup readiness failed: ${err.message}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const message of errors) {
      log(`Startup check failed: ${message}`);
    }

    throw new Error('Startup readiness check failed');
  }

  log('Startup readiness complete');
}

function describeStartupRequestError(err) {
  const message = String(err && err.message || err || 'unknown error');

  if (/timeout|abort/i.test(message)) {
    return `request timeout/abort: ${message}`;
  }

  if (/unreachable|ECONNREFUSED|fetch failed|Unable to connect/i.test(message)) {
    return `HTTP bridge unreachable: ${message}`;
  }

  if (/numeric price|missing.*timestamp|missing/i.test(message)) {
    return `quote missing: ${message}`;
  }

  return message;
}

async function runStartupRequestWithRetries(label, requestFn) {
  const retries = Math.max(1, Number(config.startup.bridgeHealthRetries || 3));
  const delayMs = Math.max(0, Number(config.startup.bridgeHealthRetryDelayMs || 2000));
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await requestFn();
      log(`${label} attempt ${attempt}/${retries} ok`);
      return result;
    } catch (err) {
      lastError = err;
      log(`${label} attempt ${attempt}/${retries} failed: ${describeStartupRequestError(err)}`);

      if (attempt < retries) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(`${label} failed after ${retries} attempt(s): ${describeStartupRequestError(lastError)}`);
}

async function handleIncomingEvent(event) {
  const symbolKey = String(event.symbol || '').toUpperCase();
  const profile = executionProfilesBySymbol.get(symbolKey);

  if (!profile) {
    log(`[SIGNALS] Ignoring ${event.source || 'external'} event for unconfigured symbol ${event.symbol}`);
    return;
  }

  if (event.eventType === 'trade_update') {
    log(`[${String(event.source || 'telegram').toUpperCase()}] UPDATE ${event.symbol}: ${(event.actions || []).join(', ')}`);
    await publishTradeUpdate(event);
    return;
  }

  if (config.learning.enabled) {
    const learningAssessment = getLearningAssessmentForSignal(event, {
      lookbackDays: config.learning.lookbackDays,
      minSettledSignals: config.learning.minSettledSignals,
    });
    event.learningAssessment = learningAssessment;

    if (
      Number.isFinite(config.learning.minScoreToTrade) &&
      learningAssessment.hasEnoughData &&
      Number.isFinite(learningAssessment.aggregateScore) &&
      learningAssessment.aggregateScore < config.learning.minScoreToTrade
    ) {
      log(
        `[LEARNING] Skipping ${event.direction} ${event.symbol} from ${event.sourceLabel || event.chatId || 'external'} `
        + `because learned score ${learningAssessment.aggregateScore} is below the trade threshold `
        + `(${config.learning.minScoreToTrade})`,
      );
      await publishSignal(event, {
        symbol: event.symbol,
        signal: event.direction,
        signalSource: event.source || profile.signalSource || 'external',
        action: 'blocked_learning',
        executed: false,
        blocked: true,
        orderRejected: false,
        executionPrice: null,
        qty: event.qty ?? null,
        orderResult: null,
        accountPositionBefore: null,
      });
      return;
    }
  }

  log(`[${String(event.source || 'signal').toUpperCase()}] ${event.direction} ${event.symbol} (${event.sourceLabel || event.chatId || 'external'})`);

  if (event.source === 'telegram' && event.isLikelyDelayedSignal) {
    log(
      `[TELEGRAM] ${event.symbol} flagged as potentially delayed (${event.delayReason || 'free_signal_delay'}) `
      + `age=${event.signalAgeMinutes || 0}m similarSignals=${event.similarSignalCount || 0}`,
    );
  }

  if (event.source === 'telegram' && Number(event.similarSignalCount) > 0) {
    log(
      `[TELEGRAM] ${event.symbol} matched ${event.similarSignalCount} recent similar signal(s)`
      + `${event.similarityAssessment && event.similarityAssessment.bestMatch ? ` best=${event.similarityAssessment.bestMatch.sourceLabel}` : ''}`,
    );
  }

  const currentQuote = profile.dataSource === 'mt5'
    ? await getLatestMt5Quote(profile.symbol)
    : { price: event.entry ?? null };
  const hybridDecision = await evaluateHybridDecision(profile, event, {
    sourceType: event.source || profile.signalSource || 'external',
    quote: currentQuote,
  });

  event.sourceType = event.source || profile.signalSource || 'external';
  event.approvalScore = hybridDecision.score;
  event.session = hybridDecision.context
    && hybridDecision.context.marketContext
    && Array.isArray(hybridDecision.context.marketContext.sessionLabels)
    ? hybridDecision.context.marketContext.sessionLabels.join('|')
    : event.session;
  event.regime = hybridDecision.context
    && hybridDecision.context.marketContext
    && hybridDecision.context.marketContext.regime
    ? hybridDecision.context.marketContext.regime
    : event.regime;

  logDecision({
    type: 'candidate_decision',
    symbol: event.symbol,
    sourceType: event.source || profile.signalSource || 'external',
    decision: hybridDecision.decision,
    score: hybridDecision.score,
    reasons: hybridDecision.reasons,
    blocks: hybridDecision.blocks,
    sourceLabel: event.sourceLabel || event.chatId || 'external',
    gateSnapshot: buildGateSnapshot(event, hybridDecision, profile),
    context: {
      quote: hybridDecision.context.quote,
      spread: hybridDecision.context.spread,
      marketContext: hybridDecision.context.marketContext,
      newsRisk: hybridDecision.context.newsRisk,
    },
  });

  if (hybridDecision.decision !== 'APPROVE') {
    log(
      `[HYBRID] ${hybridDecision.decision} ${event.direction} ${event.symbol}`
      + ` score=${hybridDecision.score} reasons=${hybridDecision.reasons.join('; ') || 'none'}`,
    );
    return;
  }

  const executionResult = await runBot(profile, {
    signal: event.direction,
    signalSource: event.source || profile.signalSource || 'external',
    qty: event.qty,
    rawSignal: event.rawText,
    normalizedSignal: event,
    price: event.entry ?? undefined,
  });

  logDecision({
    type: 'execution_result',
    symbol: event.symbol,
    sourceType: event.source || profile.signalSource || 'external',
    decision: executionResult.executed ? 'EXECUTED' : executionResult.action,
    score: hybridDecision.score,
    reasons: hybridDecision.reasons,
    execution: {
      action: executionResult.action,
      executed: executionResult.executed,
      qty: executionResult.qty,
      executionPrice: executionResult.executionPrice,
      blocked: executionResult.blocked,
      rejected: executionResult.orderRejected,
    },
  });

  await publishSignal(event, executionResult);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function acquireBotLock() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    env: process.env.TRADING_ENV || process.env.BOT_ENV || '',
  }, null, 2);

  while (true) {
    try {
      const fd = fs.openSync(botLockPath, 'wx');
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err && err.code !== 'EEXIST') {
        throw err;
      }

      try {
        const existing = JSON.parse(fs.readFileSync(botLockPath, 'utf8'));

        if (existing && existing.pid && Number(existing.pid) !== process.pid && isProcessAlive(Number(existing.pid))) {
          throw new Error(`Another bot instance is already running (pid ${existing.pid})`);
        }
      } catch (readErr) {
        if (String(readErr.message || '').includes('already running')) {
          throw readErr;
        }
      }

      try {
        fs.unlinkSync(botLockPath);
      } catch (unlinkErr) {}
    }
  }
}

function releaseBotLock() {
  try {
    if (!fs.existsSync(botLockPath)) {
      return;
    }

    const existing = JSON.parse(fs.readFileSync(botLockPath, 'utf8'));

    if (!existing || Number(existing.pid) === process.pid) {
      fs.unlinkSync(botLockPath);
    }
  } catch (err) {
    // ignore cleanup errors
  }
}

let isStrategyCycleRunning = false;
let isTelegramPollRunning = false;
let isNewsPollRunning = false;
let isResultReconciliationRunning = false;
let isTradeManagementRunning = false;
let isPublicPostingRunning = false;
const lastStrategyEvaluationBySymbol = new Map();

function getStrategyEvaluationKey(prepared = {}) {
  const signal = prepared.normalizedSignal || {};
  const symbol = String(prepared.symbol || signal.symbol || '').toUpperCase();
  const triggerBarTime = signal.triggerBarTime || (prepared.strategySetup && prepared.strategySetup.triggerBarTime) || '';
  const setupHash = signal.setupHash || (prepared.strategySetup && prepared.strategySetup.setupHash) || '';

  return `${symbol}|${triggerBarTime}|${setupHash}`;
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

function formatEmaDiagnosticValue(value) {
  return value == null || value === '' ? 'na' : String(value);
}

function logEmaPullbackDiagnostics(symbol, normalizedSignal = {}, hybridDecision = null) {
  if (String(normalizedSignal.strategyName || '').toLowerCase() !== 'ema_pullback') {
    return;
  }

  const indicators = normalizedSignal.indicators && typeof normalizedSignal.indicators === 'object'
    ? normalizedSignal.indicators
    : {};
  const diagnostics = indicators.emaPullback && typeof indicators.emaPullback === 'object'
    ? indicators.emaPullback
    : {};
  const decision = hybridDecision ? hybridDecision.decision : 'HOLD';
  const blocks = hybridDecision && Array.isArray(hybridDecision.blocks)
    ? hybridDecision.blocks.join('|')
    : '';
  const reasons = hybridDecision && Array.isArray(hybridDecision.reasons) && hybridDecision.reasons.length > 0
    ? hybridDecision.reasons.join('|')
    : (Array.isArray(normalizedSignal.strategyReasons) ? normalizedSignal.strategyReasons.join('|') : '');

  log(
    `[EMA_PULLBACK] ${String(symbol || normalizedSignal.symbol || '').toUpperCase()}`
    + ` decision=${decision}`
    + ` signal=${normalizedSignal.direction || 'na'}`
    + ` emaDirection=${formatEmaDiagnosticValue(diagnostics.emaDirection)}`
    + ` trendAligned=${formatEmaDiagnosticValue(diagnostics.trendAligned)}`
    + ` pullbackDistanceAtr=${formatEmaDiagnosticValue(diagnostics.pullbackDistanceAtr)}`
    + ` rsi=${formatEmaDiagnosticValue(diagnostics.rsi)}`
    + ` atr=${formatEmaDiagnosticValue(diagnostics.atr)}`
    + ` stopDistance=${formatEmaDiagnosticValue(diagnostics.stopDistance)}`
    + ` rrTp1=${formatEmaDiagnosticValue(diagnostics.rrTp1 ?? normalizedSignal.rrTp1)}`
    + ` rrFinal=${formatEmaDiagnosticValue(diagnostics.rrFinal ?? normalizedSignal.rrFinal)}`
    + ` session=${formatEmaDiagnosticValue(diagnostics.session || normalizedSignal.session)}`
    + ` regime=${formatEmaDiagnosticValue(diagnostics.regime || normalizedSignal.regime)}`
    + ` adx=${formatEmaDiagnosticValue(diagnostics.adx)}`
    + ` validationMode=${formatEmaDiagnosticValue(diagnostics.validationMode)}`
    + ` validationRelaxedApproval=${formatEmaDiagnosticValue(diagnostics.validationRelaxedApproval)}`
    + ` validationRelaxedGate=${formatEmaDiagnosticValue(diagnostics.validationRelaxedGate)}`
    + ` reasons=${reasons || 'none'}`
    + ` blocks=${blocks || 'none'}`,
  );
}

function buildEmaPullbackApprovalDetails(normalizedSignal = {}, hybridDecision = {}) {
  const details = [`score=${hybridDecision.score}`];
  const strategyReasons = Array.isArray(normalizedSignal.strategyReasons)
    ? normalizedSignal.strategyReasons
    : [];

  if (strategyReasons.includes('validation_relaxed_approval')) {
    details.push('reason=validation_relaxed_approval');
  }

  return details.join(' ');
}

function startStrategyLoop() {
  if (strategyProfiles.length === 0) {
    return;
  }

  (async function runStrategyLoop() {
    while (true) {
      if (isStrategyCycleRunning) {
        log('Skipping cycle: previous still running');
        await sleep(INTERVAL_MS);
        continue;
      }

      isStrategyCycleRunning = true;

      try {
        log('Running bot cycle...');
        for (const profile of strategyProfiles) {
          const prepared = await prepareBotRun(profile);
          const lifecycleSignal = prepared.normalizedSignal || {};
          const evaluationKey = getStrategyEvaluationKey(prepared);
          const previousEvaluationKey = lastStrategyEvaluationBySymbol.get(profile.symbol);

          if (prepared.normalizedSignal) {
            logSetupLifecycle(
              profile.symbol,
              lifecycleSignal,
              'evaluated',
              `signal=${prepared.signal || lifecycleSignal.direction || 'na'}`,
            );
          }

          if (config.strategy.newBarOnly && evaluationKey && previousEvaluationKey === evaluationKey) {
            if (prepared.normalizedSignal) {
              logSetupLifecycle(profile.symbol, lifecycleSignal, 'skipped_duplicate');
            }
            continue;
          }

          if (evaluationKey) {
            lastStrategyEvaluationBySymbol.set(profile.symbol, evaluationKey);
          }

          if (prepared.normalizedSignal && String(prepared.signal || prepared.normalizedSignal.direction || '').toUpperCase() === 'HOLD') {
            prepared.normalizedSignal.sourceType = 'strategy';

            if (prepared.normalizedSignal && isEurUsdBiasCandidate(prepared.normalizedSignal, profile.symbol)) {
              logEurUsdBiasDiagnostics(buildEurUsdBiasDiagnosticEvent({
                stage: 'evaluation',
                profile,
                candidate: prepared.normalizedSignal,
                hybridDecision: null,
              }));
            }

            log(
              `[STRATEGY_CANDIDATE] ${profile.symbol}`
              + ` setupHash=${prepared.normalizedSignal.setupHash || 'na'}`
              + ` triggerBarTime=${prepared.normalizedSignal.triggerBarTime || 'na'}`
              + ` rrTp1=${Number.isFinite(Number(prepared.normalizedSignal.rrTp1)) ? prepared.normalizedSignal.rrTp1 : 'na'}`
              + ` rrFinal=${Number.isFinite(Number(prepared.normalizedSignal.rrFinal)) ? prepared.normalizedSignal.rrFinal : 'na'}`
              + ` regime=${prepared.normalizedSignal.regime || 'na'}`
              + ' action=HOLD',
            );
            logEmaPullbackDiagnostics(profile.symbol, prepared.normalizedSignal, null);
            logSetupLifecycle(
              profile.symbol,
              prepared.normalizedSignal,
              'rejected',
              `reason=hold_non_executable reasons=${(prepared.normalizedSignal.strategyReasons || []).join('|') || 'none'}`,
            );
            continue;
          }

          const signalConfluence = getRecentSignalConfluence(profile.symbol, {
            maxAgeMinutes: config.getSymbolSettings(profile.symbol).maxSignalAgeMinutes,
          });
          const hybridDecision = await evaluateHybridDecision(profile, prepared.normalizedSignal || {
            symbol: profile.symbol,
            direction: prepared.signal,
            entry: prepared.price,
            stopLoss: prepared.strategySetup && prepared.strategySetup.stopLoss,
            takeProfits: prepared.strategySetup && prepared.strategySetup.takeProfits,
            strategyName: prepared.strategySetup && prepared.strategySetup.strategyName,
            confidenceLabel: prepared.strategySetup && prepared.strategySetup.confidenceLabel,
            sourceLabel: `Strategy ${profile.strategyName || config.strategy.name}`,
          }, {
            sourceType: 'strategy',
            signalConfluence,
            bars: prepared.entryBars,
          });

          if (prepared.normalizedSignal) {
            prepared.normalizedSignal.sourceType = 'strategy';
            prepared.normalizedSignal.approvalScore = hybridDecision.score;
            prepared.normalizedSignal.session = hybridDecision.context
              && hybridDecision.context.marketContext
              && Array.isArray(hybridDecision.context.marketContext.sessionLabels)
              ? hybridDecision.context.marketContext.sessionLabels.join('|')
              : prepared.normalizedSignal.session;
            prepared.normalizedSignal.regime = hybridDecision.context
              && hybridDecision.context.marketContext
              && hybridDecision.context.marketContext.regime
              ? hybridDecision.context.marketContext.regime
              : prepared.normalizedSignal.regime;
          }

          if (prepared.normalizedSignal && isEurUsdBiasCandidate(prepared.normalizedSignal, profile.symbol)) {
            logEurUsdBiasDiagnostics(buildEurUsdBiasDiagnosticEvent({
              stage: 'evaluation',
              profile,
              candidate: prepared.normalizedSignal,
              hybridDecision,
            }));
          }

          if (prepared.normalizedSignal) {
            log(
              `[STRATEGY_CANDIDATE] ${profile.symbol}`
              + ` setupHash=${prepared.normalizedSignal.setupHash || 'na'}`
              + ` triggerBarTime=${prepared.normalizedSignal.triggerBarTime || 'na'}`
              + ` rrTp1=${Number.isFinite(Number(prepared.normalizedSignal.rrTp1)) ? prepared.normalizedSignal.rrTp1 : 'na'}`
              + ` rrFinal=${Number.isFinite(Number(prepared.normalizedSignal.rrFinal)) ? prepared.normalizedSignal.rrFinal : 'na'}`
              + ` regime=${prepared.normalizedSignal.regime || 'na'}`
              + ` action=${hybridDecision.decision}`,
            );
            logEmaPullbackDiagnostics(profile.symbol, prepared.normalizedSignal, hybridDecision);
          }

          if (hybridDecision.decision === 'APPROVE' && prepared.normalizedSignal) {
            logSetupLifecycle(
              profile.symbol,
              prepared.normalizedSignal,
              'approved',
              buildEmaPullbackApprovalDetails(prepared.normalizedSignal, hybridDecision),
            );
          }

          logDecision({
            type: 'candidate_decision',
            symbol: profile.symbol,
            sourceType: 'strategy',
            decision: hybridDecision.decision,
            score: hybridDecision.score,
            reasons: hybridDecision.reasons,
            blocks: hybridDecision.blocks,
            strategyName: profile.strategyName || config.strategy.name,
            signalConfluence,
            gateSnapshot: buildGateSnapshot(prepared.normalizedSignal || {
              symbol: profile.symbol,
              strategyName: profile.strategyName || config.strategy.name,
            }, hybridDecision, profile),
            context: {
              quote: hybridDecision.context.quote,
              spread: hybridDecision.context.spread,
              marketContext: hybridDecision.context.marketContext,
              newsRisk: hybridDecision.context.newsRisk,
            },
          });

          if (hybridDecision.decision !== 'APPROVE') {
            if (prepared.normalizedSignal) {
              logSetupLifecycle(
                profile.symbol,
                prepared.normalizedSignal,
                'rejected',
                `score=${hybridDecision.score} reasons=${hybridDecision.reasons.join('|') || 'none'}`,
              );
            }
            log(
              `[HYBRID] ${hybridDecision.decision} ${profile.symbol} strategy`
              + ` score=${hybridDecision.score} reasons=${hybridDecision.reasons.join('; ') || 'none'}`,
            );
            continue;
          }

          const executionResult = await runBot(profile, { prepared });

          if (
            executionResult
            && executionResult.normalizedSignal
            && ['BUY', 'SELL'].includes(String(executionResult.signal || '').toUpperCase())
          ) {
            if (isEurUsdBiasCandidate(executionResult.normalizedSignal, profile.symbol)) {
              logEurUsdBiasDiagnostics(buildEurUsdBiasDiagnosticEvent({
                stage: 'execution',
                profile,
                candidate: executionResult.normalizedSignal,
                hybridDecision,
                executionResult,
              }));
            }
            logDecision({
              type: 'execution_result',
              symbol: profile.symbol,
              sourceType: 'strategy',
              decision: executionResult.executed ? 'EXECUTED' : executionResult.action,
              score: hybridDecision.score,
              reasons: hybridDecision.reasons,
              strategyName: profile.strategyName || config.strategy.name,
              execution: {
                action: executionResult.action,
                executed: executionResult.executed,
                qty: executionResult.qty,
                executionPrice: executionResult.executionPrice,
                blocked: executionResult.blocked,
                rejected: executionResult.orderRejected,
              },
            });
            await publishSignal(executionResult.normalizedSignal, executionResult);
          }
        }
      } catch (err) {
        log(`Error in bot cycle: ${err.message}`);
      } finally {
        isStrategyCycleRunning = false;
      }

      await sleep(INTERVAL_MS);
    }
  })();
}

function startTelegramLoop() {
  if (!config.telegram.enabled || telegramProfiles.length === 0) {
    return;
  }

  (async function runTelegramLoop() {
    while (true) {
      if (isTelegramPollRunning) {
        log('Skipping Telegram poll: previous still running');
        await sleep(config.telegram.pollIntervalMs);
        continue;
      }

      isTelegramPollRunning = true;

      try {
        const events = await pollTelegramSignals(telegramProfiles.map((profile) => profile.symbol));

        for (const event of events) {
          await handleIncomingEvent(event);
        }
      } catch (err) {
        log(`Error in Telegram poll: ${err.message}`);
      } finally {
        isTelegramPollRunning = false;
      }

      await sleep(config.telegram.pollIntervalMs);
    }
  })();
}

function startNewsLoop() {
  if (!config.news.enabled) {
    return;
  }

  (async function runNewsLoop() {
    while (true) {
      if (isNewsPollRunning) {
        log('Skipping news poll: previous still running');
        await sleep(config.news.pollIntervalMs);
        continue;
      }

      isNewsPollRunning = true;

      try {
        const signals = await pollNewsSignals({ profilesBySymbol: executionProfilesBySymbol });

        for (const signal of signals) {
          await handleIncomingEvent(signal);
        }
      } catch (err) {
        log(`Error in news poll: ${err.message}`);
      } finally {
        isNewsPollRunning = false;
      }

      await sleep(config.news.pollIntervalMs);
    }
  })();
}

function startResultReconciliationLoop() {
  (async function runResultReconciliationLoop() {
    while (true) {
      if (isResultReconciliationRunning) {
        log('Skipping result reconciliation: previous still running');
        await sleep(config.resultTracking.reconciliationIntervalMs);
        continue;
      }

      isResultReconciliationRunning = true;

      try {
        const events = await reconcileSignalResults();

        for (const event of events) {
          await publishTradeUpdate(event);
        }
      } catch (err) {
        log(`Error in result reconciliation: ${err.message}`);
      } finally {
        isResultReconciliationRunning = false;
      }

      await sleep(config.resultTracking.reconciliationIntervalMs);
    }
  })();
}

function startTradeManagementLoop() {
  (async function runTradeManagementLoop() {
    while (true) {
      if (isTradeManagementRunning) {
        log('Skipping trade management: previous still running');
        await sleep(Math.max(5000, Math.floor(config.resultTracking.reconciliationIntervalMs / 2)));
        continue;
      }

      isTradeManagementRunning = true;

      try {
        const events = await manageLiveTrades();

        for (const event of events) {
          await publishTradeUpdate(event);
        }
      } catch (err) {
        log(`Error in trade management: ${err.message}`);
      } finally {
        isTradeManagementRunning = false;
      }

      await sleep(Math.max(5000, Math.floor(config.resultTracking.reconciliationIntervalMs / 2)));
    }
  })();
}

function startPublicPostingLoop() {
  if (!config.publicSignals.enabled || !isPublishingConfigured()) {
    return;
  }

  (async function runPublicPostingLoop() {
    while (true) {
      if (isPublicPostingRunning) {
        await sleep(config.publicSignals.postingIntervalMs);
        continue;
      }

      isPublicPostingRunning = true;

      try {
        await processQueuedSignals();
      } catch (err) {
        log(`Error in public posting loop: ${err.message}`);
      } finally {
        isPublicPostingRunning = false;
      }

      await sleep(config.publicSignals.postingIntervalMs);
    }
  })();
}

function startDailySummaryLoop() {
  if (!config.dailySummary.enabled || !isPublishingConfigured()) {
    return;
  }

  (async function runDailySummaryLoop() {
    while (true) {
      try {
        const now = new Date();
        const shouldPost = now.getHours() === config.dailySummary.hourLocal
          && now.getMinutes() >= config.dailySummary.minuteLocal;

        if (shouldPost) {
          const summaryDate = new Date(now);
          summaryDate.setHours(0, 0, 0, 0);
          const dateKey = summaryDate.toISOString().slice(0, 10);
          const state = readDailySummaryState();

          if (state.lastPostedDate !== dateKey) {
            const report = aggregateDailyPerformance({ date: summaryDate.toISOString() });
            const result = await publishDailySummaryReport(report);

            if (result.posted) {
              writeDailySummaryState({ lastPostedDate: dateKey, postedAt: new Date().toISOString() });
              log(`[DAILY_SUMMARY] Posted summary for ${dateKey}`);
            }
          }
        }
      } catch (err) {
        log(`Error in daily summary loop: ${err.message}`);
      }

      await sleep(60000);
    }
  })();
}

async function start() {
  runStartupCleanup();
  acquireBotLock();
  log('Trading bot started...');
  log(`Paper trading mode: ${config.paperTradingMode}`);
  log(`Interval: ${config.intervalMs}ms`);
  log(`Profiles: ${PROFILES.map((profile) => `${profile.symbol}:${profile.signalSource}/${profile.broker}`).join(', ')}`);
  log(`Strategy assignments (active): ${strategyProfiles.map((profile) => `${profile.symbol}=${profile.strategyName || config.strategy.name}`).join(', ') || 'none'}`);
  log(`Global default strategy: ${config.strategy.name} | Entry TF: ${config.strategy.timeframe} | Confirm TFs: ${(config.strategy.confirmationTimeframes || []).join(', ') || 'none'}`);
  log(`Strategy evaluation mode: ${config.strategy.newBarOnly ? 'new-bar/new-setup only' : `every ${config.intervalMs}ms`}`);
  log(`Strategy MA: ${config.strategy.shortMa}/${config.strategy.longMa}`);
  log(`Risk per trade: ${config.risk.riskPerTrade}`);
  log(`Max position size: ${config.risk.maxPositionSize}`);
  log(`Max drawdown: ${config.risk.maxDrawdownPct * 100}%`);
  if (config.demoStress && config.demoStress.active) {
    log(`Demo stress mode active: ${config.demoStress.overrides.join(' | ')}`);
    log(
      `Demo stress safety rails:`
      + ` staleQuoteProtection=${Number(config.mt5Bridge.maxQuoteAgeMs || 0) > 0 ? `on(${config.mt5Bridge.maxQuoteAgeMs}ms)` : 'off'}`
      + ` | newBarOnly=${config.strategy.newBarOnly}`
      + ` | requireStopDistance=${config.risk.requireStopDistance}`
      + ` | maxDrawdownPct=${config.risk.maxDrawdownPct}`
      + ` | maxDailyLossPct=${config.risk.maxDailyLossPct}`
      + ` | eurusdRangingBiasDisabled=true`,
    );
  }

  if (config.telegram.enabled) {
    log(`Telegram signal polling enabled for chat ${config.telegram.chatId || 'unset'}`);
    log(
      isPublishingConfigured()
        ? `Telegram channel publishing enabled for channel ${config.telegram.postChannelId}`
        : 'Telegram channel publishing disabled until TELEGRAM_POST_BOT_TOKEN and TELEGRAM_POST_CHANNEL_ID are set',
    );

    if ((config.telegram.postBotToken && !config.telegram.postChannelId) || (!config.telegram.postBotToken && config.telegram.postChannelId)) {
      log('Telegram channel publishing is only partially configured; both TELEGRAM_POST_BOT_TOKEN and TELEGRAM_POST_CHANNEL_ID are required');
    }
  }

  if (config.news.enabled) {
    log(`News trading enabled for symbols: ${config.news.symbols.join(', ')}`);
    log(`News poll interval: ${config.news.pollIntervalMs}ms`);
    log(`News sentiment threshold: ${config.news.sentimentThreshold}`);
    log(`News allowed risk levels: ${config.news.allowedRiskLevels.join(', ')}`);
  }

  if (config.mt5Bridge.enabled) {
    if (config.mt5Bridge.autoStartHttpBridge) {
      log('MT5 HTTP bridge auto-start is enabled');
    }

    if (config.mt5Bridge.autoStartTerminal) {
      log('MT5 terminal auto-start is enabled');
    }
  }

  log(`Result reconciliation interval: ${config.resultTracking.reconciliationIntervalMs}ms`);

  await ensureMt5RuntimeReady();
  await runStartupChecks();

  startStrategyLoop();
  startTelegramLoop();
  startNewsLoop();
  startResultReconciliationLoop();
  startTradeManagementLoop();
  startPublicPostingLoop();
  startDailySummaryLoop();
  log('Bot live loop started');
}

start().catch((err) => {
  log(`Startup failed: ${err.message}`);
  releaseBotLock();
  process.exit(1);
});

process.on('exit', releaseBotLock);
process.on('SIGINT', () => {
  releaseBotLock();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseBotLock();
  process.exit(143);
});
