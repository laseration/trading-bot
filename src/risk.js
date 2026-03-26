const config = require('./config');
function calculatePositionSize(equity, price) {
  const riskAmount = equity * config.risk.riskPerTrade;
  return Math.min(Math.floor(riskAmount / price), config.risk.maxPositionSize);
}

module.exports = { calculatePositionSize };