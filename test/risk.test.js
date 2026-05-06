const test = require("node:test");
const assert = require("node:assert/strict");
const { calculatePositionSize, getContractSize, normalizePositionSize } = require("../src/risk");

test("FX contract sizing uses standard 100k lot notional", () => {
  assert.equal(getContractSize("EURUSD"), 100000);
  assert.equal(calculatePositionSize(10000, 1.1, {
    symbol: "EURUSD",
    riskPerTrade: 0.01,
    stopDistance: 0.001,
    minPositionSize: 0.01,
    positionSizeStep: 0.01,
    maxPositionSize: 10,
  }), 1);
});

test("XAUUSD contract sizing uses 100 ounce lot notional", () => {
  assert.equal(getContractSize("XAUUSD"), 100);
  assert.equal(calculatePositionSize(10000, 2400, {
    symbol: "XAUUSD",
    riskPerTrade: 0.01,
    stopDistance: 10,
    minPositionSize: 0.01,
    positionSizeStep: 0.01,
    maxPositionSize: 10,
  }), 0.1);
});

test("position size is zero when stop distance is missing and required", () => {
  assert.equal(calculatePositionSize(10000, 1.1, {
    symbol: "EURUSD",
    riskPerTrade: 0.01,
    requireStopDistance: true,
  }), 0);
});

test("normalization applies minimum size and step rounding", () => {
  assert.equal(normalizePositionSize(0.303, {
    minPositionSize: 0.1,
    positionSizeStep: 0.1,
    maxPositionSize: 10,
  }), 0.3);

  assert.equal(normalizePositionSize(0.09, {
    minPositionSize: 0.1,
    positionSizeStep: 0.01,
    maxPositionSize: 10,
  }), 0);
});

test("position size respects max position size cap", () => {
  assert.equal(calculatePositionSize(100000, 1.1, {
    symbol: "EURUSD",
    riskPerTrade: 0.05,
    stopDistance: 0.0001,
    minPositionSize: 0.01,
    positionSizeStep: 0.01,
    maxPositionSize: 2,
  }), 2);
});
