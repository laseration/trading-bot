const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");
const { generateSignal } = require("../src/strategy");
const { breakoutBars, flatBars } = require("./helpers/barFixtures");

function snapshotStrategy() {
  return JSON.parse(JSON.stringify(config.strategy));
}

function restoreStrategy(snapshot) {
  Object.keys(config.strategy).forEach((key) => delete config.strategy[key]);
  Object.assign(config.strategy, snapshot);
}

test("insufficient bars returns HOLD", () => {
  const result = generateSignal(flatBars(10), { strategyName: "trend" });

  assert.equal(result.signal, "HOLD");
  assert.deepEqual(result.reasons, ["insufficient_bars"]);
});

test("session block returns HOLD with reason", () => {
  const snapshot = snapshotStrategy();

  try {
    config.strategy.sessionStartHourUtc = 8;
    config.strategy.sessionEndHourUtc = 17;

    const result = generateSignal(flatBars(80), {
      strategyName: "trend",
      currentTimeMs: Date.UTC(2026, 0, 1, 2, 0, 0),
    });

    assert.equal(result.signal, "HOLD");
    assert.ok(result.reasons.includes("session_blocked"));
  } finally {
    restoreStrategy(snapshot);
  }
});

test("news block returns HOLD with reason", () => {
  const snapshot = snapshotStrategy();

  try {
    config.strategy.sessionStartHourUtc = 0;
    config.strategy.sessionEndHourUtc = 24;

    const result = generateSignal(flatBars(80), {
      strategyName: "trend",
      currentTimeMs: Date.UTC(2026, 0, 1, 12, 0, 0),
      hasRecentRelevantNews: true,
    });

    assert.equal(result.signal, "HOLD");
    assert.ok(result.reasons.includes("news_cooldown_blocked"));
  } finally {
    restoreStrategy(snapshot);
  }
});

test("directional setup includes stable structural fields", () => {
  const snapshot = snapshotStrategy();

  try {
    config.strategy.sessionStartHourUtc = 0;
    config.strategy.sessionEndHourUtc = 24;
    config.strategy.adxMin = 0;
    config.strategy.minAtrPct = 0;
    config.strategy.minConfirmations = 0;
    config.strategy.breakoutLookback = 20;
    config.strategy.rsiLongMin = 40;

    const result = generateSignal(breakoutBars(90), {
      strategyName: "breakout",
      currentTimeMs: Date.UTC(2026, 0, 1, 12, 0, 0),
    });

    assert.equal(result.signal, "BUY");
    assert.equal(result.direction, "BUY");
    assert.equal(result.strategyName, "breakout");
    assert.equal(typeof result.setupType, "string");
    assert.equal(typeof result.setupHash, "string");
    assert.equal(typeof result.triggerBarTime, "number");
    assert.equal(typeof result.stopDistance, "number");
    assert.ok(Array.isArray(result.takeProfits));
    assert.ok(result.takeProfits.length > 0);
    assert.ok(Number.isFinite(result.rrFinal));
  } finally {
    restoreStrategy(snapshot);
  }
});
