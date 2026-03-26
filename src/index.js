const { log } = require('./logger');

const { runBot } = require('./bot');

const INTERVAL_MS = 5000;

log("Trading bot started...");

setInterval(() => {
  log("Running bot cycle...");
  runBot();
}, INTERVAL_MS);