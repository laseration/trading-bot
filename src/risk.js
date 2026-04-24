const config = require('./config');

function getContractSize(symbol) {
  const normalized = String(symbol || '').toUpperCase();

  if (normalized === 'XAUUSD') {
    return 100;
  }

  if (normalized === 'XAGUSD') {
    return 5000;
  }

  if (normalized.includes('OIL')) {
    return 1000;
  }

  if (/^[A-Z]{6}$/.test(normalized)) {
    return 100000;
  }

  return 1;
}

function normalizePositionSize(size, options = {}) {
  const minPositionSize = Number(options.minPositionSize ?? config.risk.minPositionSize);
  const positionSizeStep = Number(options.positionSizeStep ?? config.risk.positionSizeStep);
  const maxPositionSize = Number(options.maxPositionSize ?? config.risk.maxPositionSize);
  const bounded = Math.min(Math.max(Number(size) || 0, 0), maxPositionSize);

  if (!(bounded > 0)) {
    return 0;
  }

  if (!(positionSizeStep > 0)) {
    return Number(bounded.toFixed(2));
  }

  const stepped = Math.floor(bounded / positionSizeStep) * positionSizeStep;

  if (!(stepped >= minPositionSize)) {
    return 0;
  }

  return Number(stepped.toFixed(2));
}

function calculatePositionSize(equity, price, options = {}) {
  const riskPerTrade = Number(options.riskPerTrade ?? config.risk.riskPerTrade);
  const riskAmount = Number(equity) * riskPerTrade;
  const contractSize = Number(options.contractSize || getContractSize(options.symbol));
  const requireStopDistance = options.requireStopDistance ?? config.risk.requireStopDistance;
  const stopLoss = Number(options.stopLoss);
  const stopDistance = Number(options.stopDistance);
  const inferredStopDistance = Number.isFinite(stopDistance) && stopDistance > 0
    ? stopDistance
    : (Number.isFinite(stopLoss) && Number.isFinite(Number(price))
      ? Math.abs(Number(price) - stopLoss)
      : null);

  if (Number.isFinite(inferredStopDistance) && inferredStopDistance > 0 && contractSize > 0) {
    const riskPerLot = inferredStopDistance * contractSize;
    const rawSize = riskPerLot > 0 ? riskAmount / riskPerLot : 0;
    return normalizePositionSize(rawSize, options);
  }

  if (requireStopDistance) {
    return 0;
  }

  return 0;
}

module.exports = {
  calculatePositionSize,
  getContractSize,
  normalizePositionSize,
};
