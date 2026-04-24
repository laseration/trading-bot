const broker = require('../broker');
const config = require('../config');
const { log } = require('../logger');
const { getLatestMt5Quote } = require('../mt5Bridge');
const { normalizePositionSize } = require('../risk');
const { FINAL_STATUSES, listSignals } = require('./resultTracker');

function isManagedRecord(record) {
  if (!record || record.type !== 'signal' || !record.enteredAt || FINAL_STATUSES.has(record.status)) {
    return false;
  }

  if (!record.symbol || !Array.isArray(record.takeProfits) || record.takeProfits.length === 0) {
    return false;
  }

  return true;
}

function hasReachedLevel(direction, currentPrice, targetPrice) {
  if (!Number.isFinite(Number(currentPrice)) || !Number.isFinite(Number(targetPrice))) {
    return false;
  }

  return String(direction || '').toUpperCase() === 'SELL'
    ? Number(currentPrice) <= Number(targetPrice)
    : Number(currentPrice) >= Number(targetPrice);
}

function buildTpCloseQty(record, targetIndex) {
  const remainingQty = Number(record.execution && record.execution.remainingQty);
  const totalQty = Number(record.execution && record.execution.qty);
  const knownRemaining = Number.isFinite(remainingQty) && remainingQty > 0
    ? remainingQty
    : (Number.isFinite(totalQty) ? totalQty : 0);

  if (knownRemaining <= 0) {
    return 0;
  }

  const remainingTargets = Math.max(1, record.takeProfits.length - targetIndex);
  return Number((knownRemaining / remainingTargets).toFixed(8));
}

function getInitialRisk(record) {
  const entry = Number(record.entry);
  const stopLoss = Number(record.stopLoss);

  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss)) {
    return null;
  }

  const risk = Math.abs(entry - stopLoss);
  return risk > 0 ? risk : null;
}

function getFavorableMove(record, currentPrice) {
  const entry = Number(record.entry);
  const direction = String(record.direction || '').toUpperCase();

  if (!Number.isFinite(entry) || !Number.isFinite(Number(currentPrice))) {
    return null;
  }

  return direction === 'SELL'
    ? entry - Number(currentPrice)
    : Number(currentPrice) - entry;
}

function getCurrentStopLoss(record) {
  const executionStop = Number(record.execution && record.execution.stopLoss);
  const initialStop = Number(record.stopLoss);

  if (Number.isFinite(executionStop)) {
    return executionStop;
  }

  return Number.isFinite(initialStop) ? initialStop : null;
}

function getProtectionPrecision(referencePrice) {
  const price = Number(referencePrice);
  return price >= 100 ? 2 : price >= 1 ? 5 : 6;
}

function normalizeManagedQty(value) {
  return normalizePositionSize(value, {
    minPositionSize: config.risk.minPositionSize,
    positionSizeStep: config.risk.positionSizeStep,
    maxPositionSize: Number.MAX_SAFE_INTEGER,
  });
}

function buildBreakevenEvent(record, currentPrice, nextTakeProfit) {
  if (!config.tradeManagement.breakevenEnabled || record.breakevenMoved) {
    return null;
  }

  const initialRisk = getInitialRisk(record);
  const favorableMove = getFavorableMove(record, currentPrice);
  const entry = Number(record.entry);
  const currentStop = getCurrentStopLoss(record);
  const direction = String(record.direction || '').toUpperCase();

  if (!(initialRisk > 0) || !(favorableMove >= initialRisk * Number(config.tradeManagement.breakevenTriggerRiskMultiple || 0))) {
    return null;
  }

  const buffer = initialRisk * Math.max(0, Number(config.tradeManagement.breakevenBufferRiskMultiple || 0));
  const candidateStopLoss = roundPrice(
    direction === 'SELL' ? entry - buffer : entry + buffer,
    entry,
  );

  if (
    !Number.isFinite(candidateStopLoss)
    || !Number.isFinite(currentStop)
    || (direction === 'BUY' && candidateStopLoss <= currentStop)
    || (direction === 'SELL' && candidateStopLoss >= currentStop)
  ) {
    return null;
  }

  if (
    (direction === 'BUY' && candidateStopLoss >= Number(currentPrice))
    || (direction === 'SELL' && candidateStopLoss <= Number(currentPrice))
  ) {
    return null;
  }

  return {
    id: `managed-${record.id}-breakeven-${Date.now()}`,
    signalId: record.id,
    eventType: 'trade_update',
    symbol: record.symbol,
    direction: record.direction,
    source: 'trade-manager',
    sourceChatId: record.sourceChannelId,
    chatId: record.sourceChannelId,
    sourceLabel: 'Automatic trade management',
    timestamp: new Date().toISOString(),
    rawText: `Breakeven stop adjusted for ${record.symbol}`,
    actions: ['breakeven_moved'],
    stopLoss: candidateStopLoss,
    takeProfit: Number.isFinite(Number(nextTakeProfit)) ? Number(nextTakeProfit) : null,
  };
}

function roundPrice(value, referencePrice) {
  const price = Number(referencePrice);
  const digits = price >= 100 ? 2 : price >= 1 ? 5 : 6;
  return Number(Number(value).toFixed(digits));
}

function buildProfitLockEvent(record, currentPrice, nextTakeProfit) {
  if (!config.tradeManagement.profitLockEnabled) {
    return null;
  }

  const direction = String(record.direction || '').toUpperCase();
  const entry = Number(record.entry);
  const initialStopLoss = Number(record.stopLoss);
  const currentStopLoss = Number(record.execution && record.execution.stopLoss);

  if (!Number.isFinite(entry) || !Number.isFinite(initialStopLoss) || !Number.isFinite(currentPrice)) {
    return null;
  }

  const initialRisk = Math.abs(entry - initialStopLoss);

  if (!(initialRisk > 0)) {
    return null;
  }

  const favorableMove = direction === 'SELL'
    ? entry - currentPrice
    : currentPrice - entry;
  const activationMove = initialRisk * Math.max(0, Number(config.tradeManagement.activationRiskMultiple || 0));

  if (!(favorableMove >= activationMove)) {
    return null;
  }

  const lockPct = Math.min(0.95, Math.max(0.05, Number(config.tradeManagement.lockPct || 0.5)));
  const candidateStopLossRaw = direction === 'SELL'
    ? entry - favorableMove * lockPct
    : entry + favorableMove * lockPct;
  const candidateStopLoss = roundPrice(candidateStopLossRaw, entry);
  const minStep = initialRisk * Math.max(0, Number(config.tradeManagement.minStepRiskMultiple || 0));
  const currentStop = Number.isFinite(currentStopLoss) ? currentStopLoss : initialStopLoss;
  const stopImprovement = direction === 'SELL'
    ? currentStop - candidateStopLoss
    : candidateStopLoss - currentStop;

  if (!(stopImprovement > Math.max(0, minStep))) {
    return null;
  }

  if (
    (direction === 'BUY' && candidateStopLoss >= currentPrice)
    || (direction === 'SELL' && candidateStopLoss <= currentPrice)
  ) {
    return null;
  }

  return {
    id: `managed-${record.id}-profit-lock-${Date.now()}`,
    signalId: record.id,
    eventType: 'trade_update',
    symbol: record.symbol,
    direction: record.direction,
    source: 'trade-manager',
    sourceChatId: record.sourceChannelId,
    chatId: record.sourceChannelId,
    sourceLabel: 'Automatic trade management',
    timestamp: new Date().toISOString(),
    rawText: `Profit lock adjusted for ${record.symbol}`,
    actions: [
      (
        Number.isFinite(currentStop)
        && ((direction === 'BUY' && currentStop < entry && candidateStopLoss >= entry)
          || (direction === 'SELL' && currentStop > entry && candidateStopLoss <= entry))
      )
        ? 'profit_locked'
        : 'trail_stop_advanced',
    ],
    stopLoss: candidateStopLoss,
    takeProfit: Number.isFinite(Number(nextTakeProfit)) ? Number(nextTakeProfit) : null,
  };
}

function buildTrailingEvent(record, currentPrice, nextTakeProfit) {
  if (!config.tradeManagement.trailingEnabled) {
    return null;
  }

  const management = record.management || {};

  if (config.tradeManagement.trailingStartAfterPartial && !management.partialTpTaken) {
    return null;
  }

  const direction = String(record.direction || '').toUpperCase();
  const entry = Number(record.entry);
  const initialRisk = getInitialRisk(record);
  const favorableMove = getFavorableMove(record, currentPrice);
  const currentStop = getCurrentStopLoss(record);

  if (
    !(initialRisk > 0)
    || !(favorableMove >= initialRisk * Math.max(0, Number(config.tradeManagement.trailingActivationRiskMultiple || 0)))
    || !Number.isFinite(currentStop)
  ) {
    return null;
  }

  const trailDistance = initialRisk * Math.max(0.05, Number(config.tradeManagement.trailingDistanceRiskMultiple || 0.75));
  const candidateStopLoss = roundPrice(
    direction === 'SELL' ? Number(currentPrice) + trailDistance : Number(currentPrice) - trailDistance,
    entry,
  );

  if (
    !Number.isFinite(candidateStopLoss)
    || (direction === 'BUY' && candidateStopLoss <= currentStop)
    || (direction === 'SELL' && candidateStopLoss >= currentStop)
  ) {
    return null;
  }

  if (
    (direction === 'BUY' && candidateStopLoss >= Number(currentPrice))
    || (direction === 'SELL' && candidateStopLoss <= Number(currentPrice))
  ) {
    return null;
  }

  return {
    id: `managed-${record.id}-trailing-${Date.now()}`,
    signalId: record.id,
    eventType: 'trade_update',
    symbol: record.symbol,
    direction: record.direction,
    source: 'trade-manager',
    sourceChatId: record.sourceChannelId,
    chatId: record.sourceChannelId,
    sourceLabel: 'Automatic trade management',
    timestamp: new Date().toISOString(),
    rawText: `Trailing stop adjusted for ${record.symbol}`,
    actions: [management.trailingStarted ? 'trail_stop_advanced' : 'trailing_started'],
    stopLoss: candidateStopLoss,
    takeProfit: Number.isFinite(Number(nextTakeProfit)) ? Number(nextTakeProfit) : null,
  };
}

function buildPartialTakeProfitEvent(record, currentPrice, position, targetIndex) {
  if (!config.tradeManagement.partialTakeProfitEnabled) {
    return null;
  }

  const management = record.management || {};

  if (management.partialTpTaken) {
    return null;
  }

  const initialRisk = getInitialRisk(record);
  const favorableMove = getFavorableMove(record, currentPrice);

  if (
    !(initialRisk > 0)
    || !(favorableMove >= initialRisk * Math.max(0, Number(config.tradeManagement.partialTakeProfitTriggerRiskMultiple || 0)))
  ) {
    return null;
  }

  const absolutePosition = Math.abs(Number(position) || 0);
  const closePct = Math.min(0.95, Math.max(0.05, Number(config.tradeManagement.partialTakeProfitClosePct || 0.5)));
  const rawCloseQty = absolutePosition * closePct;
  const closeQty = normalizeManagedQty(rawCloseQty);
  const remainingQty = normalizeManagedQty(absolutePosition - closeQty);

  if (!(closeQty > 0)) {
    return {
      skipped: true,
      reason: 'partial_close_qty_invalid',
    };
  }

  if (!(remainingQty >= config.risk.minPositionSize)) {
    return {
      skipped: true,
      reason: 'partial_close_remaining_invalid',
    };
  }

  const nextTakeProfit = Number(record.takeProfits[targetIndex + 1]);
  const nextStopLoss = record.breakevenMoved
    ? getCurrentStopLoss(record)
    : roundPrice(
        String(record.direction || '').toUpperCase() === 'SELL'
          ? Number(record.entry) - initialRisk * Math.max(0, Number(config.tradeManagement.breakevenBufferRiskMultiple || 0))
          : Number(record.entry) + initialRisk * Math.max(0, Number(config.tradeManagement.breakevenBufferRiskMultiple || 0)),
        Number(record.entry),
      );

  return {
    skipped: false,
    closeQty,
    remainingQty,
    nextStopLoss: Number.isFinite(Number(nextStopLoss)) ? Number(nextStopLoss) : null,
    nextTakeProfit: Number.isFinite(nextTakeProfit) ? nextTakeProfit : null,
  };
}

async function applyProtectionUpdate(record, event) {
  await broker.updatePositionProtection(
    { symbol: record.symbol, broker: 'mt5' },
    {
      side: record.direction,
      stopLoss: event.stopLoss,
      takeProfit: Number.isFinite(Number(event.takeProfit)) ? event.takeProfit : null,
    },
  );
  return event;
}

async function manageTrackedSignal(record) {
  const direction = String(record.direction || '').toUpperCase();
  const currentTpIndex = Number(record.highestTpHit || 0);
  const nextTpIndex = currentTpIndex;
  const nextTp = Number(record.takeProfits[nextTpIndex]);

  if (!Number.isFinite(nextTp)) {
    return null;
  }

  const quote = await getLatestMt5Quote(record.symbol);
  const currentPrice = quote.price;
  const account = await broker.getAccountState({ symbol: record.symbol, broker: 'mt5' }, currentPrice);
  const position = Number(account.position);

  if (!Number.isFinite(position) || position === 0) {
    return null;
  }

  const expectedSign = direction === 'SELL' ? -1 : 1;

  if (Math.sign(position) !== expectedSign) {
    return null;
  }

  const activeTakeProfit = Number(record.takeProfits[nextTpIndex]);

  if (!hasReachedLevel(direction, currentPrice, nextTp)) {
    const breakevenEvent = buildBreakevenEvent(record, currentPrice, activeTakeProfit);

    if (breakevenEvent) {
      log(`[MANAGER] ${record.symbol} breakeven moved to ${breakevenEvent.stopLoss}`);
      return applyProtectionUpdate(record, breakevenEvent);
    }

    const profitLockEvent = buildProfitLockEvent(record, currentPrice, activeTakeProfit);

    if (profitLockEvent) {
      log(`[MANAGER] ${record.symbol} profit lock moved stop to ${profitLockEvent.stopLoss}`);
      return applyProtectionUpdate(record, profitLockEvent);
    }

    const trailingEvent = buildTrailingEvent(record, currentPrice, activeTakeProfit);

    if (trailingEvent) {
      log(`[MANAGER] ${record.symbol} trailing stop moved to ${trailingEvent.stopLoss}`);
      return applyProtectionUpdate(record, trailingEvent);
    }

    return null;
  }

  const partialPlan = buildPartialTakeProfitEvent(record, currentPrice, position, nextTpIndex);

  if (partialPlan && partialPlan.skipped) {
    log(`[MANAGER] ${record.symbol} partial TP skipped: ${partialPlan.reason}`);
  }

  if (partialPlan && !partialPlan.skipped) {
    const closeSide = direction === 'SELL' ? 'BUY' : 'SELL';
    const partialOrderResult = await broker.placeOrder(
      { symbol: record.symbol, broker: 'mt5' },
      closeSide,
      partialPlan.closeQty,
      currentPrice,
      {
        comment: `${config.mt5Bridge.commentPrefix}:${record.symbol}:PARTIAL_TP1`,
        signalSource: 'trade-manager',
        rawSignal: 'Partial TP auto-management',
      },
    );

    if (partialOrderResult && partialOrderResult.rejected) {
      log(`[MANAGER] ${record.symbol} partial TP rejected: ${partialOrderResult.reason}`);
      return null;
    }

    if (Number.isFinite(partialPlan.nextStopLoss) || Number.isFinite(partialPlan.nextTakeProfit)) {
      await broker.updatePositionProtection(
        { symbol: record.symbol, broker: 'mt5' },
        {
          side: record.direction,
          stopLoss: Number.isFinite(partialPlan.nextStopLoss) ? partialPlan.nextStopLoss : null,
          takeProfit: Number.isFinite(partialPlan.nextTakeProfit) ? partialPlan.nextTakeProfit : null,
        },
      );
    }

    log(
      `[MANAGER] ${record.symbol} partial TP taken: closed ${partialPlan.closeQty}, `
      + `remaining ${partialPlan.remainingQty}, stop ${partialPlan.nextStopLoss}`,
    );

    return {
      id: `managed-${record.id}-partial-${Date.now()}`,
      signalId: record.id,
      eventType: 'trade_update',
      symbol: record.symbol,
      direction: record.direction,
      source: 'trade-manager',
      sourceChatId: record.sourceChannelId,
      chatId: record.sourceChannelId,
      sourceLabel: 'Automatic trade management',
      timestamp: new Date().toISOString(),
      rawText: `Auto-managed partial TP for ${record.symbol}`,
      actions: [
        'partial_tp_taken',
        'tp1_hit',
        'breakeven_moved',
      ],
      closedQty: partialPlan.closeQty,
      stopLoss: Number.isFinite(partialPlan.nextStopLoss) ? partialPlan.nextStopLoss : null,
      takeProfit: Number.isFinite(partialPlan.nextTakeProfit) ? partialPlan.nextTakeProfit : null,
      orderResult: partialOrderResult,
    };
  }

  const closeSide = direction === 'SELL' ? 'BUY' : 'SELL';
  const closeQty = nextTpIndex >= record.takeProfits.length - 1
    ? Math.abs(position)
    : buildTpCloseQty(record, nextTpIndex);

  if (!(closeQty > 0)) {
    return null;
  }

  const orderResult = await broker.placeOrder(
    { symbol: record.symbol, broker: 'mt5' },
    closeSide,
    closeQty,
    currentPrice,
    {
      comment: `${config.mt5Bridge.commentPrefix}:${record.symbol}:TP${nextTpIndex + 1}`,
      signalSource: 'trade-manager',
      rawSignal: `TP${nextTpIndex + 1} auto-management`,
    },
  );

  const actions = [`tp${nextTpIndex + 1}_hit`];
  let nextStopLoss = Number(record.execution && record.execution.stopLoss);
  let nextTakeProfit = null;

  if (nextTpIndex === 0) {
    nextStopLoss = Number(record.entry);
    actions.push('move_sl_to_breakeven');
  }

  if (nextTpIndex >= record.takeProfits.length - 1) {
    actions.push('closed_profit');
  } else {
    nextTakeProfit = Number(record.takeProfits[nextTpIndex + 1]);
    await broker.updatePositionProtection(
      { symbol: record.symbol, broker: 'mt5' },
      {
        side: record.direction,
        stopLoss: Number.isFinite(nextStopLoss) ? nextStopLoss : null,
        takeProfit: Number.isFinite(nextTakeProfit) ? nextTakeProfit : null,
      },
    );
  }

  return {
    id: `managed-${record.id}-tp${nextTpIndex + 1}-${Date.now()}`,
    signalId: record.id,
    eventType: 'trade_update',
    symbol: record.symbol,
    direction: record.direction,
    source: 'trade-manager',
    sourceChatId: record.sourceChannelId,
    chatId: record.sourceChannelId,
    sourceLabel: 'Automatic trade management',
    timestamp: new Date().toISOString(),
    rawText: `Auto-managed TP${nextTpIndex + 1} for ${record.symbol}`,
    actions,
    closedQty: closeQty,
    orderResult,
  };
}

async function manageLiveTrades() {
  if (!config.mt5Bridge.enabled || config.paperTradingMode) {
    return [];
  }

  const records = listSignals().filter(isManagedRecord);
  const events = [];

  for (const record of records) {
    try {
      const event = await manageTrackedSignal(record);

      if (event) {
        events.push(event);
      }
    } catch (err) {
      log(`[MANAGER] Failed to manage ${record.symbol} (${record.id}): ${err.message}`);
    }
  }

  return events;
}

module.exports = {
  manageLiveTrades,
};
