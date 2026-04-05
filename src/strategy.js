const config = require('./config');

function movingAverage(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

function generateSignal(closes) {
  if (closes.length < config.strategy.longMa) return "HOLD";

  const shortMA = movingAverage(closes, config.strategy.shortMa);
  const longMA = movingAverage(closes, config.strategy.longMa);

  if (shortMA === null || longMA === null) return "HOLD";
  if (shortMA > longMA) return "BUY";
  if (shortMA < longMA) return "SELL";
  return "HOLD";
}

module.exports = { generateSignal };
