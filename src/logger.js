const fs = require("fs");
const path = require("path");

const logFilePath = path.join(__dirname, "..", "bot.log");
const tradeHistoryPath = path.join(__dirname, "..", "trade-history.csv");

function logTrade(trade) {
  if (!fs.existsSync(tradeHistoryPath)) {
    fs.appendFileSync(
      tradeHistoryPath,
      "timestamp,side,qty,price,cash,position,equity\n"
    );
  }

  const line = [
    trade.timestamp,
    trade.side,
    trade.qty,
    trade.price,
    trade.cash,
    trade.position,
    trade.equity,
  ].join(",");

  fs.appendFileSync(tradeHistoryPath, line + "\n");
}

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;

  console.log(line);
  fs.appendFileSync(logFilePath, line + "\n");
}

module.exports = { log, logTrade };
