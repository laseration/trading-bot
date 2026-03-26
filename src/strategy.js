function movingAverage(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

function generateSignal(closes) {
  if (closes.length < 50) return "HOLD";

  const fast = movingAverage(closes, 20);
  const slow = movingAverage(closes, 50);

  if (fast === null || slow === null) return "HOLD";
  if (fast > slow) return "BUY";
  if (fast < slow) return "SELL";
  return "HOLD";
}

module.exports = { generateSignal };