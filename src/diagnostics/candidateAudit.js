const fs = require("fs");

const DECISION_BUCKETS = ["HOLD", "WATCH", "REJECT", "APPROVE", "EXECUTED"];
const SCORE_BUCKETS = [
  { label: "0-19", min: 0, max: 19 },
  { label: "20-39", min: 20, max: 39 },
  { label: "40-59", min: 40, max: 59 },
  { label: "60-79", min: 60, max: 79 },
  { label: "80-100", min: 80, max: 100 },
  { label: "other", min: null, max: null },
];

function readFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return null;
  }
}

function parseJsonLines(text) {
  const records = [];
  const errors = [];

  String(text || "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return;
      }

      try {
        records.push(JSON.parse(trimmed));
      } catch (err) {
        errors.push({ line: index + 1, message: err.message });
      }
    });

  return { records, errors };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < String(line || "").length; index += 1) {
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

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function increment(map, key, amount = 1) {
  const normalizedKey = String(key || "unknown").trim() || "unknown";
  map[normalizedKey] = (map[normalizedKey] || 0) + amount;
}

function incrementMany(map, values, options = {}) {
  const usable = Array.isArray(values) ? values : values ? [values] : [];

  if (usable.length === 0) {
    if (options.includeNone) {
      increment(map, "none");
    }
    return;
  }

  usable.forEach((value) => increment(map, value));
}

function normalizeDecision(record) {
  const explicit = record.decision || record.status || record.action;

  if (explicit) {
    return String(explicit).toUpperCase();
  }

  if (record.executed === true) {
    return "EXECUTED";
  }

  if (record.signal && String(record.signal).toUpperCase() === "HOLD") {
    return "HOLD";
  }

  return "UNKNOWN";
}

function getNested(record, keys) {
  for (const key of keys) {
    if (record && record[key] != null && record[key] !== "") {
      return record[key];
    }
  }

  return null;
}

function getRecordSession(record) {
  const direct = getNested(record, ["session"]);

  if (direct) {
    return direct;
  }

  const labels = record.context
    && record.context.marketContext
    && record.context.marketContext.sessionLabels;

  if (Array.isArray(labels) && labels.length > 0) {
    return labels.join("+");
  }

  return "";
}

function normalizeCandidateRecord(record, source) {
  const decision = normalizeDecision(record);
  const score = Number(record.approvalScore ?? record.score);

  return {
    source,
    decision,
    symbol: getNested(record, ["symbol"]),
    session: getRecordSession(record),
    regime: getNested(record, ["regime"])
      || (record.context && record.context.marketContext && record.context.marketContext.regime),
    setupType: getNested(record, ["setupType"]),
    strategyName: getNested(record, ["strategyName"]),
    approvalScore: Number.isFinite(score) ? score : null,
    rejectionReasons: [
      ...(Array.isArray(record.reasons) ? record.reasons : []),
      ...(Array.isArray(record.hybridDecisionReasons) ? record.hybridDecisionReasons : []),
    ],
    hardBlocks: [
      ...(Array.isArray(record.blocks) ? record.blocks : []),
      ...(Array.isArray(record.hybridDecisionBlocks) ? record.hybridDecisionBlocks : []),
    ],
  };
}

function scoreBucket(score) {
  if (!Number.isFinite(score)) {
    return "other";
  }

  const bucket = SCORE_BUCKETS.find((candidate) => {
    if (candidate.min == null || candidate.max == null) {
      return false;
    }

    return score >= candidate.min && score <= candidate.max;
  });

  return bucket ? bucket.label : "other";
}

function countBy(records, field) {
  return records.reduce((counts, record) => {
    increment(counts, record[field]);
    return counts;
  }, {});
}

function topCounts(counts, limit = 10) {
  return Object.entries(counts || {})
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function summarizeCandidates(records) {
  const normalized = records.map((record) => normalizeCandidateRecord(record.record, record.source));
  const decisionCounts = DECISION_BUCKETS.reduce((counts, decision) => {
    counts[decision] = 0;
    return counts;
  }, {});
  const rejectionReasons = {};
  const hardBlocks = {};
  const scoreHistogram = SCORE_BUCKETS.reduce((counts, bucket) => {
    counts[bucket.label] = 0;
    return counts;
  }, {});

  normalized.forEach((record) => {
    increment(decisionCounts, record.decision);

    if (["HOLD", "WATCH", "REJECT"].includes(record.decision)) {
      incrementMany(rejectionReasons, record.rejectionReasons);
    }

    incrementMany(hardBlocks, record.hardBlocks);

    if (record.approvalScore != null) {
      increment(scoreHistogram, scoreBucket(record.approvalScore));
    }
  });

  return {
    totalCandidates: normalized.length,
    decisionCounts,
    topRejectionReasons: topCounts(rejectionReasons),
    topHardBlocks: topCounts(hardBlocks),
    bySymbol: countBy(normalized, "symbol"),
    bySession: countBy(normalized, "session"),
    byRegime: countBy(normalized, "regime"),
    bySetupType: countBy(normalized, "setupType"),
    byStrategyName: countBy(normalized, "strategyName"),
    scoreHistogram,
  };
}

function hasExecutionIdentity(signal) {
  const execution = signal && signal.execution ? signal.execution : {};
  return Boolean(execution.orderId || execution.positionId);
}

function summarizeSignals(signalStore) {
  const signals = Object.values((signalStore && signalStore.signals) || {})
    .filter((record) => record && record.type === "signal");
  const entered = signals.filter((record) => record.enteredAt);
  const missingExecutionIdentity = entered.filter((record) => !hasExecutionIdentity(record));
  const reconciled = signals.filter((record) => {
    const reconciliation = record.reconciliation || {};
    return Boolean(reconciliation.exitTradeKey || reconciliation.reconciledAt);
  });
  const ignored = signals.filter((record) => {
    const reconciliation = record.reconciliation || {};
    return Boolean(reconciliation.ignoredReason);
  });
  const ignoredReasons = {};

  ignored.forEach((record) => increment(ignoredReasons, record.reconciliation.ignoredReason));

  return {
    totalTrackedSignals: signals.length,
    enteredSignals: entered.length,
    trackedSignalsMissingExecutionIdentity: missingExecutionIdentity.length,
    signalsWithExecutionIdentity: entered.length - missingExecutionIdentity.length,
    reconciledSignals: reconciled.length,
    reconciliationIgnoredRecords: ignored.length,
    reconciliationIgnoredReasons: topCounts(ignoredReasons),
  };
}

function summarizeTradeRows(tradeHistoryRows, tradeEventRows) {
  const executedEvents = tradeEventRows.filter((row) => {
    const type = String(row.event_type || "").toLowerCase();
    return type === "position_opened" || type === "position_closed" || type === "position_reduced";
  });

  return {
    tradeHistoryRows: tradeHistoryRows.length,
    tradeEventRows: tradeEventRows.length,
    executedEventRows: executedEvents.length,
  };
}

function buildCandidateAudit(inputs = {}) {
  const candidateRecords = [];
  const parseErrors = [];

  if (inputs.decisionHistoryText != null) {
    const parsed = parseJsonLines(inputs.decisionHistoryText);
    parseErrors.push(...parsed.errors.map((error) => ({ ...error, source: "decision-history.jsonl" })));
    candidateRecords.push(...parsed.records.map((record) => ({ source: "decision-history", record })));
  }

  if (inputs.eurusdBiasDiagnosticsText != null) {
    const parsed = parseJsonLines(inputs.eurusdBiasDiagnosticsText);
    parseErrors.push(...parsed.errors.map((error) => ({ ...error, source: "eurusd-bias-diagnostics.jsonl" })));
    candidateRecords.push(...parsed.records.map((record) => ({ source: "eurusd-bias-diagnostics", record })));
  }

  const tradeHistoryRows = inputs.tradeHistoryCsvText == null ? [] : parseCsv(inputs.tradeHistoryCsvText);
  const tradeEventRows = inputs.tradeEventsCsvText == null ? [] : parseCsv(inputs.tradeEventsCsvText);
  let signalStore = null;

  if (inputs.signalResultsText != null) {
    try {
      signalStore = JSON.parse(inputs.signalResultsText);
    } catch (err) {
      parseErrors.push({ source: "signal-results.json", line: null, message: err.message });
      signalStore = null;
    }
  }

  return {
    sourcesPresent: {
      decisionHistory: inputs.decisionHistoryText != null,
      eurusdBiasDiagnostics: inputs.eurusdBiasDiagnosticsText != null,
      tradeHistory: inputs.tradeHistoryCsvText != null,
      tradeEvents: inputs.tradeEventsCsvText != null,
      signalResults: inputs.signalResultsText != null,
    },
    parseErrors,
    candidates: summarizeCandidates(candidateRecords),
    reconciliation: summarizeSignals(signalStore),
    trades: summarizeTradeRows(tradeHistoryRows, tradeEventRows),
  };
}

module.exports = {
  buildCandidateAudit,
  parseCsv,
  parseCsvLine,
  parseJsonLines,
  readFileIfPresent,
  scoreBucket,
  summarizeCandidates,
  summarizeSignals,
  topCounts,
};
