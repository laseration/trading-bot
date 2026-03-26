const config = require('./config');

function movingAverage(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

function generateSignal(closes) {
  if (closes.length < 50) return "HOLD";

  const shortMA = movingAverage(prices, config.strategy.shortMa);
  const longMA = movingAverage(prices, config.strategy.longMa);

  if (fast === null || slow === null) return "HOLD";
  if (fast > slow) return "BUY";
  if (fast < slow) return "SELL";
  return "HOLD";
}

module.exports = { generateSignal };