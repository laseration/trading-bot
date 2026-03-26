function positionSize(equity, price, riskPercent = 0.01) {
  if (price <= 0) return 0;
  const riskAmount = equity * riskPercent;
  return Math.max(0, Math.floor(riskAmount / price));
}

module.exports = { positionSize };