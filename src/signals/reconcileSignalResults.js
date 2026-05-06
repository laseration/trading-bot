const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log } = require('../logger');
const { getMt5TradeHistory } = require('../mt5Bridge');
const { getPipSize } = require('./performanceAggregator');
const { FINAL_STATUSES, listSignals, updateSignalRecord } = require('./resultTracker');

const TRADE_EVENTS_PATH = path.join(__dirname, '..', '..', 'logs', 'trade-events.csv');
const MT5_DEAL_ENTRY_OUT = 1;
const MT5_DEAL_ENTRY_INOUT = 2;
const MT5_DEAL_ENTRY_OUT_BY = 3;
const MT5_DEAL_TYPE_BUY = 0;
const MT5_DEAL_TYPE_SELL = 1;
const ENTRY_EVENT_TYPES = new Set(['position_opened']);
const EXIT_EVENT_TYPES = new Set(['position_closed', 'position_reduced']);

function parseCsvRow(line, headers) {
  const values = String(line || '').split(',');
  const row = {};

  headers.forEach((header, index) => {
    row[header] = values[index] ?? '';
  });

  return row;
}

function readTradeEventRows(options = {}) {
  const eventTypes = Array.isArray(options.eventTypes)
    ? new Set(options.eventTypes.map((value) => String(value || '').toLowerCase()))
    : null;

  if (!fs.existsSync(TRADE_EVENTS_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(TRADE_EVENTS_PATH, 'utf8').trim();

  if (!raw) {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');

  return lines.slice(1)
    .map((line) => parseCsvRow(line, headers))
    .map((row) => ({
      source: 'trade-events',
      tradeKey: `${row.timestamp}|${row.symbol}|${row.event_type}|${row.side}|${row.price}|${row.qty}`,
      timestamp: row.timestamp,
      symbol: row.symbol,
      side: String(row.side || '').toUpperCase(),
      qty: Number(row.qty),
      price: Number(row.price),
      position: row.position === '' ? null : Number(row.position),
      orderId: row.order_id === '' ? null : row.order_id,
      positionId: row.position_id === '' ? null : row.position_id,
      eventType: row.event_type || '',
      status: row.status || '',
      comment: row.notes || '',
    }))
    .filter((row) => {
      if (!(row.timestamp && row.symbol && row.side)) {
        return false;
      }

      if (!eventTypes) {
        return true;
      }

      return eventTypes.has(String(row.eventType || '').toLowerCase());
    });
}

function normalizeMt5Deal(deal) {
  return {
    source: 'mt5-history',
    tradeKey: `mt5-${deal.ticket}`,
    ticket: deal.ticket,
    timestamp: Number.isFinite(Number(deal.time))
      ? new Date(Number(deal.time) * 1000).toISOString()
      : '',
    symbol: deal.symbol,
    side: Number(deal.type) === MT5_DEAL_TYPE_SELL ? 'SELL' : 'BUY',
    qty: Number(deal.volume),
    price: Number(deal.price),
    pnl: Number.isFinite(Number(deal.profit)) ? Number(deal.profit) : null,
    entry: Number(deal.entry),
    comment: deal.comment || '',
    magic: deal.magic,
    positionId: deal.positionId,
  };
}

function isMt5ExitDeal(deal) {
  return [
    MT5_DEAL_ENTRY_OUT,
    MT5_DEAL_ENTRY_INOUT,
    MT5_DEAL_ENTRY_OUT_BY,
  ].includes(Number(deal.entry));
}

async function readMt5ExitRows(symbols = []) {
  if (!config.mt5Bridge.enabled) {
    return [];
  }

  const fromEpoch = Math.floor(Date.now() / 1000) - config.resultTracking.reconciliationLookbackDays * 24 * 60 * 60;
  const rows = [];

  for (const symbol of symbols) {
    try {
      const deals = await getMt5TradeHistory({
        symbol,
        fromEpoch,
        limit: 100,
      });

      rows.push(
        ...deals
          .filter(isMt5ExitDeal)
          .map(normalizeMt5Deal),
      );
    } catch (err) {
      log(`[TRACKER] MT5 history lookup failed for ${symbol}: ${err.message}`);
    }
  }

  return rows;
}

function inferExitSide(direction) {
  return String(direction || '').toUpperCase() === 'SELL' ? 'BUY' : 'SELL';
}

function rankTpHits(record, exitPrice) {
  const takeProfits = Array.isArray(record.takeProfits) ? record.takeProfits : [];
  const direction = String(record.direction || '').toUpperCase();
  let highest = 0;

  takeProfits.forEach((takeProfit, index) => {
    const value = Number(takeProfit);

    if (!Number.isFinite(value) || !Number.isFinite(Number(exitPrice))) {
      return;
    }

    const hit = direction === 'SELL'
      ? Number(exitPrice) <= value
      : Number(exitPrice) >= value;

    if (hit) {
      highest = index + 1;
    }
  });

  return highest;
}

function inferNetPoints(record, exitPrice) {
  const entry = Number((record.execution && record.execution.executionPrice) ?? record.entry);
  const exit = Number(exitPrice);

  if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
    return null;
  }

  const pipSize = getPipSize(record.symbol);
  const rawDifference = String(record.direction || '').toUpperCase() === 'SELL'
    ? entry - exit
    : exit - entry;

  return Number((rawDifference / pipSize).toFixed(1));
}

function inferOutcome(record, exitRow) {
  const netPoints = inferNetPoints(record, exitRow.price);

  if (Number.isFinite(exitRow.pnl)) {
    if (exitRow.pnl > 0) {
      return { finalOutcome: 'win', netPoints };
    }

    if (exitRow.pnl < 0) {
      return { finalOutcome: 'loss', netPoints };
    }
  }

  if (Number.isFinite(netPoints)) {
    if (netPoints > 0) {
      return { finalOutcome: 'win', netPoints };
    }

    if (netPoints < 0) {
      return { finalOutcome: 'loss', netPoints };
    }
  }

  return {
    finalOutcome: null,
    netPoints,
  };
}

function inferActions(record, exitRow, options = {}) {
  const highestTpHit = rankTpHits(record, exitRow.price);
  const { finalOutcome, netPoints } = inferOutcome(record, exitRow);
  const isFinal = Boolean(options.isFinal);

  if (!isFinal) {
    return {
      actions: ['partial_close'],
      highestTpHit,
      finalOutcome,
      status: record.status || 'entered',
      netPoints,
    };
  }

  const actions = [];
  let status = 'closed';

  if (finalOutcome === 'loss') {
    const stopLoss = Number(record.stopLoss);
    const pipTolerance = getPipSize(record.symbol) * 5;
    const exitPrice = Number(exitRow.price);
    const nearStop = Number.isFinite(stopLoss) && Number.isFinite(exitPrice)
      ? Math.abs(stopLoss - exitPrice) <= pipTolerance
      : false;

    if (nearStop) {
      status = 'sl_hit';
      actions.push('sl_hit');
    } else {
      actions.push('closed_loss');
    }
  } else if (finalOutcome === 'win') {
    actions.push('closed_profit');
  } else {
    actions.push('closed');
  }

  return {
    actions: Array.from(new Set(actions)),
    highestTpHit,
    finalOutcome,
    status,
    netPoints,
  };
}

function getProcessedTradeKeys(record) {
  const keys = new Set();

  if (record.reconciliation && record.reconciliation.exitTradeKey) {
    keys.add(record.reconciliation.exitTradeKey);
  }

  if (record.reconciliation && Array.isArray(record.reconciliation.processedExitTradeKeys)) {
    for (const key of record.reconciliation.processedExitTradeKeys) {
      if (key) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function findIdentityFromEntryRows(record, entryRows) {
  const enteredAtMs = Date.parse(record.enteredAt || record.updatedAt || 0);
  const entryQty = Number(record.execution && record.execution.qty);
  const direction = String(record.direction || record.execution && record.execution.side || '').toUpperCase();
  const candidates = entryRows
    .filter((row) => {
      if (row.symbol !== record.symbol) {
        return false;
      }

      if (String(row.side || '').toUpperCase() !== direction) {
        return false;
      }

      const rowTimeMs = Date.parse(row.timestamp || 0);

      if (!Number.isFinite(rowTimeMs) || Math.abs(rowTimeMs - enteredAtMs) > 2 * 60 * 1000) {
        return false;
      }

      if (Number.isFinite(entryQty) && entryQty > 0 && Number.isFinite(row.qty) && row.qty > 0) {
        return Math.abs(row.qty - entryQty) <= 1e-8;
      }

      return true;
    })
    .sort((left, right) => Math.abs(Date.parse(left.timestamp) - enteredAtMs) - Math.abs(Date.parse(right.timestamp) - enteredAtMs));

  if (candidates.length !== 1) {
    return null;
  }

  return {
    orderId: candidates[0].orderId ?? null,
    positionId: candidates[0].positionId ?? null,
  };
}

function getRecordIdentity(record, entryRows) {
  const execution = record.execution || {};
  const orderId = execution.orderId ?? null;
  const positionId = execution.positionId ?? null;

  if (orderId || positionId) {
    return { orderId, positionId, source: 'tracked_execution' };
  }

  const inferred = findIdentityFromEntryRows(record, entryRows);

  if (inferred && (inferred.orderId || inferred.positionId)) {
    return { ...inferred, source: 'trade_events_entry' };
  }

  return { orderId: null, positionId: null, source: 'none' };
}

function getReconciliationIdentityStatus(record, entryRows = []) {
  const identity = getRecordIdentity(record, entryRows);

  return {
    identity,
    ignoredReason: identity.orderId || identity.positionId ? null : 'missing_execution_identity',
  };
}

function markRecordReconciliationIgnored(record, reason) {
  if (!record || !record.id) {
    return;
  }

  updateSignalRecord(record.id, (nextRecord) => {
    nextRecord.reconciliation = {
      ...(nextRecord.reconciliation || {}),
      ignoredReason: reason,
      ignoredAt: new Date().toISOString(),
    };
    return nextRecord;
  });
}

function getNextCompetingEntryTime(record, trackedSignals) {
  const recordEnteredAtMs = Date.parse(record.enteredAt || record.updatedAt || 0);

  return trackedSignals
    .filter((candidate) => {
      if (candidate.id === record.id) {
        return false;
      }

      if (candidate.symbol !== record.symbol) {
        return false;
      }

      const candidateTimeMs = Date.parse(candidate.enteredAt || candidate.updatedAt || 0);
      return Number.isFinite(candidateTimeMs) && candidateTimeMs > recordEnteredAtMs;
    })
    .map((candidate) => Date.parse(candidate.enteredAt || candidate.updatedAt || 0))
    .sort((left, right) => left - right)[0] || null;
}

function selectMatchedExitRows(record, exitRows, options = {}) {
  const enteredAtMs = Date.parse(record.enteredAt || record.updatedAt || 0);
  const expectedExitSide = inferExitSide(record.direction);
  const processedTradeKeys = getProcessedTradeKeys(record);
  const usedExitTradeKeys = options.usedExitTradeKeys || new Set();
  const identity = options.identity || { orderId: null, positionId: null, source: 'none' };
  const nextCompetingEntryTimeMs = options.nextCompetingEntryTimeMs;
  const entryQty = Number(record.execution && record.execution.qty);
  const remainingQty = Number(record.execution && record.execution.remainingQty);
  const qtyLimit = Number.isFinite(remainingQty) && remainingQty > 0
    ? remainingQty
    : entryQty;

  const candidates = exitRows
    .filter((row) => {
      if (row.symbol !== record.symbol) {
        return false;
      }

      if (String(row.side || '').toUpperCase() !== expectedExitSide) {
        return false;
      }

      const tradeTimeMs = Date.parse(row.timestamp || 0);

      if (!Number.isFinite(tradeTimeMs) || tradeTimeMs < enteredAtMs) {
        return false;
      }

      if (processedTradeKeys.has(row.tradeKey)) {
        return false;
      }

      if (usedExitTradeKeys.has(row.tradeKey)) {
        return false;
      }

      return true;
    })
    .map((row) => {
      let priority = 0;

      if (identity.positionId && row.positionId && String(row.positionId) === String(identity.positionId)) {
        priority = 300;
      } else if (identity.orderId && row.orderId && String(row.orderId) === String(identity.orderId)) {
        priority = 250;
      } else if (identity.orderId && row.ticket && String(row.ticket) === String(identity.orderId)) {
        priority = 240;
      } else if (identity.positionId || identity.orderId) {
        priority = -1;
      } else {
        const rowTimeMs = Date.parse(row.timestamp || 0);

        if (Number.isFinite(nextCompetingEntryTimeMs) && rowTimeMs >= nextCompetingEntryTimeMs) {
          priority = -1;
        } else {
          priority = 100 - Math.min(99, Math.floor((rowTimeMs - enteredAtMs) / 1000));
        }
      }

      return {
        ...row,
        priority,
      };
    })
    .filter((row) => row.priority >= 0)
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }

      return Date.parse(left.timestamp) - Date.parse(right.timestamp);
    });

  if (candidates.length === 0) {
    return [];
  }

  const matched = [];
  let runningQty = 0;

  for (const candidate of candidates) {
    if (identity.positionId || identity.orderId) {
      matched.push(candidate);
      usedExitTradeKeys.add(candidate.tradeKey);

      if (Number.isFinite(candidate.qty) && candidate.qty > 0) {
        runningQty += candidate.qty;
      }

      if (Number.isFinite(qtyLimit) && qtyLimit > 0 && runningQty >= qtyLimit - 1e-8) {
        break;
      }

      continue;
    }

    matched.push(candidate);
    usedExitTradeKeys.add(candidate.tradeKey);

    if (Number.isFinite(candidate.qty) && candidate.qty > 0) {
      runningQty += candidate.qty;
    }

    if (Number.isFinite(qtyLimit) && qtyLimit > 0 && runningQty >= qtyLimit - 1e-8) {
      break;
    }
  }

  return matched.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function reconcileSignalResults() {
  const trackedSignals = listSignals().filter((record) => {
    if (record.type !== 'signal') {
      return false;
    }

    if (!record.enteredAt) {
      return false;
    }

    return !FINAL_STATUSES.has(record.status);
  });

  if (trackedSignals.length === 0) {
    return [];
  }

  const tradeEventRows = readTradeEventRows({ eventTypes: [...EXIT_EVENT_TYPES] });
  const entryEventRows = readTradeEventRows({ eventTypes: [...ENTRY_EVENT_TYPES] });
  const mt5Rows = await readMt5ExitRows([...new Set(trackedSignals.map((record) => record.symbol).filter(Boolean))]);
  const exitRows = [...tradeEventRows, ...mt5Rows];
  const events = [];
  const usedExitTradeKeys = new Set();
  const orderedTrackedSignals = [...trackedSignals].sort((left, right) => {
    return Date.parse(left.enteredAt || left.updatedAt || 0) - Date.parse(right.enteredAt || right.updatedAt || 0);
  });

  for (const record of orderedTrackedSignals) {
    const identityStatus = getReconciliationIdentityStatus(record, entryEventRows);
    const { identity } = identityStatus;

    if (identityStatus.ignoredReason) {
      markRecordReconciliationIgnored(record, identityStatus.ignoredReason);
      continue;
    }

    const nextCompetingEntryTimeMs = getNextCompetingEntryTime(record, orderedTrackedSignals);
    const matchedExitRows = selectMatchedExitRows(record, exitRows, {
      identity,
      nextCompetingEntryTimeMs,
      usedExitTradeKeys,
    });

    if (matchedExitRows.length === 0) {
      continue;
    }

    const entryQty = Number(record.execution && record.execution.qty);
    const remainingQty = Number(record.execution && record.execution.remainingQty);
    const priorClosedQty = Number.isFinite(entryQty) && Number.isFinite(remainingQty)
      ? Math.max(0, entryQty - Math.max(0, remainingQty))
      : 0;
    let runningClosedQty = priorClosedQty;

    for (const exitRow of matchedExitRows) {
      const closedQty = Number(exitRow.qty);

      if (Number.isFinite(closedQty) && closedQty > 0) {
        runningClosedQty += closedQty;
      }

      const isFinal = Number.isFinite(entryQty) && entryQty > 0
        ? runningClosedQty >= entryQty - 1e-8
        : matchedExitRows[matchedExitRows.length - 1] === exitRow;
      const inferred = inferActions(record, exitRow, { isFinal });

      events.push({
        id: `reconcile-${record.id}-${exitRow.tradeKey}`,
        signalId: record.id,
        eventType: 'trade_update',
        symbol: record.symbol,
        direction: record.direction,
        source: 'reconciliation',
        sourceChatId: record.sourceChannelId,
        chatId: record.sourceChannelId,
        sourceLabel: 'Automatic result reconciliation',
        timestamp: exitRow.timestamp,
        rawText: `Automatically reconciled from ${exitRow.source}`,
        actions: inferred.actions,
        closedQty: Number.isFinite(closedQty) ? closedQty : null,
        reconciliation: {
          exitTradeKey: exitRow.tradeKey,
          exitSource: exitRow.source,
          exitPrice: exitRow.price,
          highestTpHit: inferred.highestTpHit,
          finalOutcome: inferred.finalOutcome,
          status: inferred.status,
          netPoints: inferred.netPoints,
          pnl: exitRow.pnl,
          closedQty: Number.isFinite(closedQty) ? closedQty : null,
          ticket: exitRow.ticket ?? null,
          orderId: exitRow.orderId ?? null,
          positionId: exitRow.positionId ?? null,
          matchingIdentity: identity,
        },
      });
    }
  }

  return events;
}

module.exports = {
  getProcessedTradeKeys,
  getRecordIdentity,
  getReconciliationIdentityStatus,
  inferActions,
  readTradeEventRows,
  reconcileSignalResults,
  selectMatchedExitRows,
};
