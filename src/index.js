const config = require('./config');

const { log } = require('./logger');

const { runBot } = require('./bot');

const INTERVAL_MS = config.intervalMs;

log("Trading bot started...");
log(`Interval: ${config.intervalMs}ms`);
log(`Strategy MA: ${config.strategy.shortMa}/${config.strategy.longMa}`);
log(`Risk per trade: ${config.risk.riskPerTrade}`);
log(`Max position size: ${config.risk.maxPositionSize}`);
log(`Max drawdown: ${config.risk.maxDrawdownPct * 100}%`);

setInterval(() => {
  log("Running bot cycle...");
  runBot();
}, INTERVAL_MS);