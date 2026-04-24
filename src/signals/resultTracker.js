const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'logs', 'signal-results.json');
const FINAL_STATUSES = new Set(['sl_hit', 'closed', 'cancelled']);

function emptyStore() {
  return {
    version: 1,
    signals: {},
  };
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

function readStore() {
  ensureStoreDir();

  if (!fs.existsSync(STORE_PATH)) {
    return emptyStore();
  }

  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8').trim();
    return raw ? JSON.parse(raw) : emptyStore();
  } catch (err) {
    return emptyStore();
  }
}

function writeStore(store) {
  ensureStoreDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function toIsoTimestamp(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function ensureStatusHistory(record) {
  if (!Array.isArray(record.statusHistory)) {
    record.statusHistory = [];
  }
}

function buildSignalRecord(signal) {
  const timestamp = signal.timestamp || toIsoTimestamp();

  return {
    id: signal.id,
    type: signal.eventType || 'signal',
    timestamp,
    symbol: signal.symbol || '',
    direction: signal.direction || signal.side || '',
    entry: signal.entry ?? null,
    stopLoss: signal.stopLoss ?? null,
    takeProfits: Array.isArray(signal.takeProfits) ? signal.takeProfits : [],
    timeframe: signal.timeframe || '',
    strategyName: signal.strategyName || '',
    strategyFamily: signal.strategyFamily || '',
    setupType: signal.setupType || '',
    setupHash: signal.setupHash || '',
    triggerBarTime: signal.triggerBarTime || null,
    validUntilBar: signal.validUntilBar || null,
    sourceType: signal.sourceType || signal.source || '',
    riskLabel: signal.riskLabel || signal.riskLevel || '',
    approvalScore: Number.isFinite(Number(signal.approvalScore)) ? Number(signal.approvalScore) : null,
    rrTp1: Number.isFinite(Number(signal.rrTp1)) ? Number(signal.rrTp1) : null,
    rrFinal: Number.isFinite(Number(signal.rrFinal)) ? Number(signal.rrFinal) : null,
    session: signal.session || '',
    regime: signal.regime || '',
    confidenceLabel: signal.confidenceLabel || '',
    sourceLabel: signal.sourceLabel || '',
    rawText: signal.rawText || signal.text || '',
    qty: signal.qty ?? null,
    sourceChannelId: signal.sourceChatId || signal.chatId || '',
    sourceChannelName: signal.sourceChatTitle || signal.chatTitle || '',
    sourceMessageId: signal.messageId ?? null,
    replyToMessageId: signal.replyToMessageId ?? null,
    postedAt: null,
    updatedAt: timestamp,
    enteredAt: null,
    postMessageId: null,
    postChannelId: null,
    postError: null,
    status: 'received',
    finalOutcome: null,
    pipsOrPointsResult: null,
    highestTpHit: 0,
    breakevenMoved: false,
    management: {
      partialTpTaken: false,
      partialTpTakenAt: null,
      partialTpClosedQty: 0,
      trailingStarted: false,
      trailingStartedAt: null,
      trailingUpdatedAt: null,
      lastManagedStopLoss: signal.stopLoss ?? null,
      lastManagedTakeProfit: Array.isArray(signal.takeProfits) && signal.takeProfits.length > 0
        ? signal.takeProfits[signal.takeProfits.length - 1]
        : null,
    },
    lastUpdateText: '',
    execution: {
      side: signal.direction || signal.side || '',
      qty: signal.qty ?? null,
      remainingQty: signal.qty ?? null,
      executionPrice: null,
      exitPrice: null,
      orderId: null,
      positionId: null,
      stopLoss: signal.stopLoss ?? null,
      takeProfit: Array.isArray(signal.takeProfits) && signal.takeProfits.length > 0
        ? signal.takeProfits[signal.takeProfits.length - 1]
        : null,
      brokerStatus: null,
    },
    reconciliation: {
      exitTradeKey: null,
      exitSource: '',
      reconciledAt: null,
      processedExitTradeKeys: [],
    },
    statusHistory: [
      {
        status: 'received',
        timestamp,
        note: 'Signal captured by Telegram reader',
      },
    ],
  };
}

function upsertSignalRecord(signal) {
  const store = readStore();
  const existing = store.signals[signal.id];
  const nextRecord = existing
    ? {
        ...existing,
        symbol: signal.symbol || existing.symbol,
        direction: signal.direction || signal.side || existing.direction,
        timestamp: signal.timestamp || existing.timestamp || existing.updatedAt,
        entry: signal.entry ?? existing.entry,
        stopLoss: signal.stopLoss ?? existing.stopLoss,
        takeProfits: Array.isArray(signal.takeProfits) && signal.takeProfits.length > 0
          ? signal.takeProfits
          : existing.takeProfits,
        timeframe: signal.timeframe || existing.timeframe,
        strategyName: signal.strategyName || existing.strategyName,
        strategyFamily: signal.strategyFamily || existing.strategyFamily,
        setupType: signal.setupType || existing.setupType,
        setupHash: signal.setupHash || existing.setupHash,
        triggerBarTime: signal.triggerBarTime || existing.triggerBarTime,
        validUntilBar: signal.validUntilBar || existing.validUntilBar,
        sourceType: signal.sourceType || signal.source || existing.sourceType,
        riskLabel: signal.riskLabel || signal.riskLevel || existing.riskLabel,
        approvalScore: Number.isFinite(Number(signal.approvalScore))
          ? Number(signal.approvalScore)
          : existing.approvalScore,
        rrTp1: Number.isFinite(Number(signal.rrTp1))
          ? Number(signal.rrTp1)
          : existing.rrTp1,
        rrFinal: Number.isFinite(Number(signal.rrFinal))
          ? Number(signal.rrFinal)
          : existing.rrFinal,
        session: signal.session || existing.session,
        regime: signal.regime || existing.regime,
        confidenceLabel: signal.confidenceLabel || existing.confidenceLabel,
        sourceLabel: signal.sourceLabel || existing.sourceLabel,
        rawText: signal.rawText || signal.text || existing.rawText,
        qty: signal.qty ?? existing.qty,
        sourceChannelId: signal.sourceChatId || signal.chatId || existing.sourceChannelId,
        sourceChannelName: signal.sourceChatTitle || signal.chatTitle || existing.sourceChannelName,
        sourceMessageId: signal.messageId ?? existing.sourceMessageId,
        replyToMessageId: signal.replyToMessageId ?? existing.replyToMessageId,
        updatedAt: signal.timestamp || toIsoTimestamp(),
        management: {
          ...(existing.management || {}),
        },
      }
    : buildSignalRecord(signal);

  if (existing) {
    ensureStatusHistory(nextRecord);
  }

  store.signals[signal.id] = nextRecord;
  writeStore(store);
  return nextRecord;
}

function appendStatus(record, status, note, metadata = {}) {
  const timestamp = metadata.timestamp || toIsoTimestamp();
  ensureStatusHistory(record);
  record.status = status;
  record.updatedAt = timestamp;
  record.statusHistory.push({
    status,
    timestamp,
    note: note || '',
  });
}

function updateSignalRecord(signalId, updater) {
  const store = readStore();
  const record = store.signals[signalId];

  if (!record) {
    return null;
  }

  const updatedRecord = updater(record) || record;
  store.signals[signalId] = updatedRecord;
  writeStore(store);
  return updatedRecord;
}

function markSignalPosted(signalId, publishResult = {}, note = 'Signal published to Telegram channel') {
  return updateSignalRecord(signalId, (record) => {
    if (record.postMessageId) {
      return record;
    }

    appendStatus(record, 'posted', note, { timestamp: publishResult.timestamp || toIsoTimestamp() });
    record.postedAt = publishResult.timestamp || record.postedAt || toIsoTimestamp();
    record.postMessageId = publishResult.messageId ?? record.postMessageId;
    record.postChannelId = publishResult.channelId ?? record.postChannelId;
    record.postError = null;
    return record;
  });
}

function markSignalPostFailed(signalId, errorMessage) {
  return updateSignalRecord(signalId, (record) => {
    record.postError = errorMessage;
    record.updatedAt = toIsoTimestamp();
    return record;
  });
}

function markSignalStatus(signalId, status, note, metadata = {}, extraFields = {}) {
  return updateSignalRecord(signalId, (record) => {
    appendStatus(record, status, note, metadata);
    Object.assign(record, extraFields);
    return record;
  });
}

function markSignalEntered(signalId, execution = {}) {
  return updateSignalRecord(signalId, (record) => {
    if (record.enteredAt) {
      return record;
    }

    appendStatus(record, 'entered', 'Trade entered by execution engine', {
      timestamp: execution.timestamp || toIsoTimestamp(),
    });
    record.enteredAt = execution.timestamp || record.enteredAt || toIsoTimestamp();
    record.execution = {
      ...record.execution,
      qty: execution.qty ?? record.execution.qty,
      remainingQty: execution.remainingQty ?? record.execution.remainingQty ?? execution.qty ?? record.execution.qty,
      executionPrice: execution.executionPrice ?? record.execution.executionPrice,
      exitPrice: execution.exitPrice ?? record.execution.exitPrice,
      orderId: execution.orderId ?? record.execution.orderId,
      positionId: execution.positionId ?? record.execution.positionId,
      stopLoss: execution.stopLoss ?? record.execution.stopLoss,
      takeProfit: execution.takeProfit ?? record.execution.takeProfit,
      brokerStatus: execution.brokerStatus ?? record.execution.brokerStatus,
      side: execution.side || record.execution.side,
    };
    return record;
  });
}

function listSignals() {
  const store = readStore();
  return Object.values(store.signals);
}

function getSignal(signalId) {
  const store = readStore();
  return store.signals[signalId] || null;
}

function isFinalStatus(status) {
  return FINAL_STATUSES.has(status);
}

function findLatestTrackedSignal({ symbol, sourceChannelId, direction } = {}) {
  const candidates = listSignals()
    .filter((record) => {
      if (symbol && record.symbol !== symbol) {
        return false;
      }

      if (sourceChannelId && record.sourceChannelId && record.sourceChannelId !== sourceChannelId) {
        return false;
      }

      if (direction && record.direction && record.direction !== direction) {
        return false;
      }

      return !isFinalStatus(record.status);
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.postedAt || 0);
      const rightTime = Date.parse(right.updatedAt || right.postedAt || 0);
      return rightTime - leftTime;
    });

  return candidates[0] || null;
}

module.exports = {
  FINAL_STATUSES,
  STORE_PATH,
  appendStatus,
  getSignal,
  isFinalStatus,
  listSignals,
  findLatestTrackedSignal,
  markSignalEntered,
  markSignalStatus,
  markSignalPostFailed,
  markSignalPosted,
  readStore,
  toIsoTimestamp,
  updateSignalRecord,
  upsertSignalRecord,
};
