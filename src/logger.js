const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "..", "logs", "bot.log");
const tradeHistoryPath = path.join(__dirname, "..", "logs", "trade-history.csv");
const tradeEventsPath = path.join(__dirname, "..", "logs", "trade-events.csv");
const equityHistoryPath = path.join(__dirname, "..", "logs", "equity-history.csv");
const decisionHistoryPath = path.join(__dirname, "..", "logs", "decision-history.jsonl");
const tradeAttributionPath = path.join(__dirname, "..", "logs", "trade-attribution.jsonl");
const managementAnalysisPath = path.join(__dirname, "..", "logs", "management-effectiveness.jsonl");
const eurusdBiasDiagnosticsPath = path.join(__dirname, "..", "logs", "eurusd-bias-diagnostics.jsonl");
const tradeHistoryHeader = [
  "closed_at",
  "symbol",
  "side",
  "entry_price",
  "exit_price",
  "qty",
  "pnl",
  "pnl_currency",
  "trade_duration_seconds",
  "entry_time",
  "exit_time",
  "source_type",
  "strategy_name",
  "risk_label",
  "approval_score",
  "ticket",
  "position_id",
  "close_event_key",
  "close_reason",
  "stop_loss",
  "take_profit",
  "max_favorable_excursion",
  "max_adverse_excursion",
  "session",
  "regime",
  "publicly_posted",
  "notes",
].join(",");
const tradeEventsHeader = "timestamp,symbol,event_type,side,qty,price,position,position_id,order_id,status,notes";
const equityHistoryHeader = "timestamp,symbol,cash,position,equity";

function csvEscape(value) {
  if (value == null) {
    return "";
  }

  const stringValue = String(value);

  if (!/[",\r\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, '""')}"`;
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

function ensureCsvHeader(filePath, expectedHeader) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, `${expectedHeader}\n`);
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);
  const currentHeader = (lines[0] || "").trim();

  if (currentHeader === expectedHeader) {
    return;
  }

  const backupPath = `${filePath.replace(/\.csv$/i, "")}.legacy-${Date.now()}.csv`;
  fs.renameSync(filePath, backupPath);
  fs.writeFileSync(filePath, `${expectedHeader}\n`);
}

function appendCsvRow(filePath, expectedHeader, columns, row) {
  ensureCsvHeader(filePath, expectedHeader);
  const line = columns.map((column) => csvEscape(row[column])).join(",");
  fs.appendFileSync(filePath, `${line}\n`);
}

function hasCsvRowWithValue(filePath, columnName, value) {
  if (value == null || value === "" || !fs.existsSync(filePath)) {
    return false;
  }

  const contents = fs.readFileSync(filePath, "utf8").trim();

  if (!contents) {
    return false;
  }

  const lines = contents.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const columnIndex = headers.indexOf(columnName);

  if (columnIndex < 0) {
    return false;
  }

  return lines.slice(1).some((line) => parseCsvLine(line)[columnIndex] === String(value));
}

function logTrade(trade) {
  if (hasCsvRowWithValue(tradeHistoryPath, "close_event_key", trade.close_event_key)) {
    return;
  }

  appendCsvRow(
    tradeHistoryPath,
    tradeHistoryHeader,
    tradeHistoryHeader.split(","),
    trade,
  );
}

function logTradeEvent(event) {
  appendCsvRow(
    tradeEventsPath,
    tradeEventsHeader,
    tradeEventsHeader.split(","),
    event,
  );
}

function logEquity(snapshot) {
  appendCsvRow(
    equityHistoryPath,
    equityHistoryHeader,
    equityHistoryHeader.split(","),
    snapshot,
  );
}

function log(message) {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;

  console.log(line);
  fs.appendFileSync(logFilePath, line + "\n");
}

function logDecision(decision) {
  fs.mkdirSync(path.dirname(decisionHistoryPath), { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    ...decision,
  };

  fs.appendFileSync(decisionHistoryPath, `${JSON.stringify(payload)}\n`);
}

function logTradeAttribution(entry) {
  fs.mkdirSync(path.dirname(tradeAttributionPath), { recursive: true });
  fs.appendFileSync(tradeAttributionPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function logManagementAnalysis(entry) {
  fs.mkdirSync(path.dirname(managementAnalysisPath), { recursive: true });
  fs.appendFileSync(managementAnalysisPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function logEurUsdBiasDiagnostics(entry) {
  fs.mkdirSync(path.dirname(eurusdBiasDiagnosticsPath), { recursive: true });
  fs.appendFileSync(eurusdBiasDiagnosticsPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

module.exports = {
  log,
  logTrade,
  logTradeEvent,
  logEquity,
  logDecision,
  logTradeAttribution,
  logManagementAnalysis,
  logEurUsdBiasDiagnostics,
};
