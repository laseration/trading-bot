const { log } = require('../logger');
const { calculateDirectionalPoints } = require('./performanceAggregator');
const {
  appendStatus,
  findLatestTrackedSignal,
  getSignal,
  toIsoTimestamp,
  updateSignalRecord,
} = require('./resultTracker');

function normalizeActions(actions = []) {
  return Array.from(new Set(actions.filter(Boolean)));
}

function resolveSignalForUpdate(updateEvent) {
  if (updateEvent.signalId) {
    const exact = getSignal(updateEvent.signalId);

    if (exact) {
      return exact;
    }
  }

  return findLatestTrackedSignal({
    symbol: updateEvent.symbol,
    sourceChannelId: updateEvent.sourceChatId || updateEvent.chatId,
    direction: updateEvent.direction,
  });
}

function computeOutcomeFromActions(actions = []) {
  if (actions.includes('sl_hit')) {
    return 'loss';
  }

  if (actions.includes('closed_profit')) {
    return 'win';
  }

  if (actions.includes('closed_loss')) {
    return 'loss';
  }

  return null;
}

function computeResultFromRecord(record) {
  if (record.finalOutcome === 'loss') {
    return calculateDirectionalPoints({
      symbol: record.symbol,
      direction: record.direction,
      entry: (record.execution && record.execution.executionPrice) ?? record.entry,
      exit: (record.execution && record.execution.stopLoss) ?? record.stopLoss,
    });
  }

  const tpIndex = Math.max(0, Number(record.highestTpHit || 0) - 1);
  const exit = Array.isArray(record.takeProfits) ? record.takeProfits[tpIndex] : null;

  if (record.finalOutcome === 'win' && exit != null) {
    return calculateDirectionalPoints({
      symbol: record.symbol,
      direction: record.direction,
      entry: (record.execution && record.execution.executionPrice) ?? record.entry,
      exit: (record.execution && record.execution.exitPrice) ?? exit,
    });
  }

  return null;
}

function describeAction(action) {
  switch (action) {
    case 'partial_tp_taken':
      return 'Partial take profit executed';
    case 'trailing_started':
      return 'Trailing stop started';
    case 'breakeven_moved':
      return 'Stop loss moved to breakeven';
    case 'partial_close':
      return 'Partial close recorded';
    case 'tp1_hit':
      return 'TP1 hit';
    case 'tp2_hit':
      return 'TP2 hit';
    case 'tp3_hit':
      return 'TP3 hit';
    case 'move_sl_to_breakeven':
      return 'Stop loss moved to breakeven';
    case 'profit_locked':
      return 'Profit lock activated';
    case 'trail_stop_advanced':
      return 'Trailing stop advanced';
    case 'sl_hit':
      return 'Stop loss hit';
    case 'closed_profit':
      return 'Trade closed in profit';
    case 'closed_loss':
      return 'Trade closed in loss';
    case 'closed':
      return 'Trade closed';
    case 'cancelled':
      return 'Signal cancelled';
    default:
      return action;
  }
}

function applyTradeUpdate(updateEvent) {
  const matchedSignal = resolveSignalForUpdate(updateEvent);

  if (!matchedSignal) {
    log(`[TRACKER] No tracked signal found for update ${updateEvent.id} (${updateEvent.symbol || 'unknown symbol'})`);
    return null;
  }

  const actions = normalizeActions(updateEvent.actions);
  const nextTimestamp = updateEvent.timestamp || toIsoTimestamp();
  const includesManagedPartial = actions.includes('partial_tp_taken');

  return updateSignalRecord(matchedSignal.id, (record) => {
    const reconciliation = updateEvent.reconciliation || null;

    if (
      reconciliation &&
      reconciliation.exitTradeKey &&
      record.reconciliation &&
      record.reconciliation.exitTradeKey === reconciliation.exitTradeKey
    ) {
      return record;
    }

    record.lastUpdateText = updateEvent.rawText || updateEvent.text || record.lastUpdateText;

    for (const action of actions) {
      if (action === 'tp1_hit') {
        record.highestTpHit = Math.max(Number(record.highestTpHit || 0), 1);
        if (!includesManagedPartial && Number.isFinite(Number(record.execution && record.execution.remainingQty))) {
          record.execution.remainingQty = Number(Math.max(0, Number(record.execution.remainingQty) - Number(updateEvent.closedQty || 0)).toFixed(8));
        }
        appendStatus(record, 'tp1_hit', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'tp2_hit') {
        record.highestTpHit = Math.max(Number(record.highestTpHit || 0), 2);
        if (Number.isFinite(Number(record.execution && record.execution.remainingQty))) {
          record.execution.remainingQty = Number(Math.max(0, Number(record.execution.remainingQty) - Number(updateEvent.closedQty || 0)).toFixed(8));
        }
        appendStatus(record, 'tp2_hit', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'tp3_hit') {
        record.highestTpHit = Math.max(Number(record.highestTpHit || 0), 3);
        if (Number.isFinite(Number(record.execution && record.execution.remainingQty))) {
          record.execution.remainingQty = Number(Math.max(0, Number(record.execution.remainingQty) - Number(updateEvent.closedQty || 0)).toFixed(8));
        }
        appendStatus(record, 'tp3_hit', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'move_sl_to_breakeven' || action === 'breakeven_moved') {
        record.breakevenMoved = true;
        if (record.execution) {
          record.execution.stopLoss = Number.isFinite(Number(updateEvent.stopLoss))
            ? Number(updateEvent.stopLoss)
            : Number(record.entry);
        }
        record.management = {
          ...(record.management || {}),
          lastManagedStopLoss: record.execution ? record.execution.stopLoss : updateEvent.stopLoss,
        };
        appendStatus(record, record.status || 'posted', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'partial_tp_taken') {
        record.management = {
          ...(record.management || {}),
          partialTpTaken: true,
          partialTpTakenAt: nextTimestamp,
          partialTpClosedQty: Number(record.management && record.management.partialTpClosedQty || 0)
            + Number(updateEvent.closedQty || 0),
        };
        appendStatus(record, record.status || 'entered', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'partial_close') {
        if (record.execution && Number.isFinite(Number(updateEvent.closedQty))) {
          const nextRemainingQty = Number(record.execution.remainingQty);
          if (Number.isFinite(nextRemainingQty)) {
            record.execution.remainingQty = Number(Math.max(0, nextRemainingQty - Number(updateEvent.closedQty)).toFixed(8));
          }
        }
        appendStatus(record, record.status || 'entered', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'trailing_started' || action === 'profit_locked' || action === 'trail_stop_advanced') {
        if (record.execution && Number.isFinite(Number(updateEvent.stopLoss))) {
          record.execution.stopLoss = Number(updateEvent.stopLoss);
        }
        if (record.execution && Number.isFinite(Number(updateEvent.takeProfit))) {
          record.execution.takeProfit = Number(updateEvent.takeProfit);
        }
        record.management = {
          ...(record.management || {}),
          trailingStarted: record.management && record.management.trailingStarted || action === 'trailing_started',
          trailingStartedAt: record.management && record.management.trailingStartedAt
            || (action === 'trailing_started' ? nextTimestamp : null),
          trailingUpdatedAt: nextTimestamp,
          lastManagedStopLoss: Number.isFinite(Number(updateEvent.stopLoss))
            ? Number(updateEvent.stopLoss)
            : (record.management && record.management.lastManagedStopLoss),
          lastManagedTakeProfit: Number.isFinite(Number(updateEvent.takeProfit))
            ? Number(updateEvent.takeProfit)
            : (record.management && record.management.lastManagedTakeProfit),
        };
        appendStatus(record, record.status || 'posted', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'sl_hit') {
        record.finalOutcome = 'loss';
        if (record.execution) {
          record.execution.remainingQty = 0;
        }
        appendStatus(record, 'sl_hit', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'closed_profit') {
        record.finalOutcome = 'win';
        if (record.execution) {
          record.execution.remainingQty = 0;
        }
        appendStatus(record, 'closed', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'closed_loss') {
        record.finalOutcome = 'loss';
        if (record.execution) {
          record.execution.remainingQty = 0;
        }
        appendStatus(record, 'closed', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'closed') {
        record.finalOutcome = record.finalOutcome || computeOutcomeFromActions(actions);
        if (record.execution) {
          record.execution.remainingQty = 0;
        }
        appendStatus(record, 'closed', describeAction(action), { timestamp: nextTimestamp });
      } else if (action === 'cancelled') {
        record.finalOutcome = null;
        appendStatus(record, 'cancelled', describeAction(action), { timestamp: nextTimestamp });
      }
    }

    if (!record.finalOutcome) {
      record.finalOutcome = computeOutcomeFromActions(actions) || record.finalOutcome;
    }

    if (reconciliation) {
      if (Number.isFinite(Number(reconciliation.highestTpHit))) {
        record.highestTpHit = Math.max(Number(record.highestTpHit || 0), Number(reconciliation.highestTpHit));
      }

      if (reconciliation.finalOutcome) {
        record.finalOutcome = reconciliation.finalOutcome;
      }

      if (Number.isFinite(Number(reconciliation.netPoints))) {
        record.pipsOrPointsResult = Number(reconciliation.netPoints);
      }

      record.execution = {
        ...record.execution,
        exitPrice: Number.isFinite(Number(reconciliation.exitPrice))
          ? Number(reconciliation.exitPrice)
          : record.execution && record.execution.exitPrice,
      };
      record.reconciliation = {
        ...(record.reconciliation || {}),
        exitTradeKey: reconciliation.exitTradeKey || ((record.reconciliation || {}).exitTradeKey),
        exitSource: reconciliation.exitSource || ((record.reconciliation || {}).exitSource),
        reconciledAt: nextTimestamp,
        processedExitTradeKeys: Array.from(
          new Set([
            ...(((record.reconciliation || {}).processedExitTradeKeys) || []),
            reconciliation.exitTradeKey,
          ].filter(Boolean)),
        ),
      };

      if (record.execution && Number.isFinite(Number(reconciliation.closedQty))) {
        const remainingQty = Number(record.execution.remainingQty);
        if (Number.isFinite(remainingQty) && !actions.some((action) => ['tp1_hit', 'tp2_hit', 'tp3_hit', 'partial_close'].includes(action))) {
          record.execution.remainingQty = Number(Math.max(0, remainingQty - Number(reconciliation.closedQty)).toFixed(8));
        }
      }
    }

    const result = reconciliation && Number.isFinite(Number(reconciliation.netPoints))
      ? null
      : computeResultFromRecord(record);
    record.pipsOrPointsResult = Number.isFinite(result) ? result : record.pipsOrPointsResult;
    record.updatedAt = nextTimestamp;
    return record;
  });
}

module.exports = {
  applyTradeUpdate,
  describeAction,
};
