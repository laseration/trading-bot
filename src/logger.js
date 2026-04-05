const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "..", "logs", "bot.log");
const tradeHistoryPath = path.join(__dirname, "..", "logs", "trade-history.csv");
const equityHistoryPath = path.join(__dirname, "..", "logs", "equity-history.csv");
const tradeHistoryHeader = "timestamp,symbol,side,qty,price,pnl,cash,position,equity";
const equityHistoryHeader = "timestamp,symbol,cash,position,equity";

function ensureCsvHeader(filePath, expectedHeader, migrateRow) {
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

  const migratedLines = lines
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map(migrateRow);

  const nextContents = [expectedHeader, ...migratedLines].join("\n");
  fs.writeFileSync(filePath, `${nextContents}\n`);
}

function logTrade(trade) {
  ensureCsvHeader(tradeHistoryPath, tradeHistoryHeader, (line) => {
    const values = line.split(",");
    values.splice(1, 0, "");
    return values.join(",");
  });

  const line = [
    trade.timestamp,
    trade.symbol ?? "",
    trade.side,
    trade.qty,
    trade.price,
    trade.pnl ?? "",
    trade.cash,
    trade.position,
    trade.equity,
  ].join(",");

  fs.appendFileSync(tradeHistoryPath, line + "\n");
}

function logEquity(snapshot) {
  ensureCsvHeader(equityHistoryPath, equityHistoryHeader, (line) => {
    const values = line.split(",");
    values.splice(1, 0, "");
    return values.join(",");
  });

  const line = [
    snapshot.timestamp,
    snapshot.symbol ?? "",
    snapshot.cash,
    snapshot.position,
    snapshot.equity,
  ].join(",");

  fs.appendFileSync(equityHistoryPath, line + "\n");
}

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;

  console.log(line);
  fs.appendFileSync(logFilePath, line + "\n");
}

module.exports = { log, logTrade, logEquity };
