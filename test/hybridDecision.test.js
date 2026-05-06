const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateHybridDecision } = require("../src/hybridDecision");

function baseProfile() {
  return {
    symbol: "EURUSD",
    dataSource: "mt5",
    signalSource: "strategy",
    broker: "mt5",
  };
}

function baseQuote(overrides = {}) {
  return {
    bid: 1.1,
    ask: 1.1001,
    price: 1.10005,
    ...overrides,
  };
}

function baseMarketContext(overrides = {}) {
  return {
    valid: true,
    latestClose: 1.1,
    emaFast: 1.1005,
    emaSlow: 1.1,
    rsi: 55,
    atr: 0.001,
    adx: 25,
    atrPct: 0.001,
    trendBias: "BUY",
    regime: "TRENDING",
    sessionLabels: ["LONDON"],
    sessionOpen: true,
    ...overrides,
  };
}

function baseCandidate(overrides = {}) {
  return {
    symbol: "EURUSD",
    direction: "BUY",
    entry: 1.1,
    stopLoss: 1.099,
    takeProfits: [1.1015, 1.102],
    stopDistance: 0.001,
    strategyName: "bias",
    setupType: "trend_continuation",
    rrTp1: 1.5,
    rrFinal: 2,
    indicators: {
      emaFast: 1.1005,
      emaSlow: 1.1,
      rsi: 55,
      emaSeparationAtr: 0.2,
      continuationLong: true,
      longStructureOk: true,
      pullbackOk: true,
      h1Bias: { direction: "BUY" },
      triggerCandle: { longConfirmed: true },
    },
    ...overrides,
  };
}

async function decide(candidateOverrides = {}, contextOverrides = {}, quoteOverrides = {}) {
  return evaluateHybridDecision(baseProfile(), baseCandidate(candidateOverrides), {
    sourceType: "STRATEGY",
    quote: baseQuote(quoteOverrides),
    marketContext: baseMarketContext(contextOverrides),
    newsRisk: false,
    signalConfluence: { count: 0, consensusDirection: null },
  });
}

test("session filter block is surfaced", async () => {
  const result = await decide({}, {
    sessionLabels: ["ASIA"],
    sessionOpen: false,
  });

  assert.equal(result.decision, "REJECT");
  assert.ok(result.blocks.includes("session_filter"));
  assert.ok(result.blocks.includes("eurusd_asia_session_block"));
});

test("spread filter block is surfaced", async () => {
  const result = await decide({}, {}, {
    bid: 1.1,
    ask: 1.102,
    price: 1.101,
  });

  assert.ok(result.blocks.includes("spread_filter"));
  assert.ok(result.reasons.includes("spread too wide"));
});

test("news block is surfaced", async () => {
  const result = await evaluateHybridDecision(baseProfile(), baseCandidate(), {
    sourceType: "STRATEGY",
    quote: baseQuote(),
    marketContext: baseMarketContext(),
    newsRisk: true,
    signalConfluence: { count: 0, consensusDirection: null },
  });

  assert.ok(result.blocks.includes("news_risk"));
  assert.ok(result.reasons.includes("major news cooldown active"));
});

test("EURUSD bias requires setupType", async () => {
  const result = await decide({ setupType: "" });

  assert.equal(result.decision, "REJECT");
  assert.ok(result.blocks.includes("eurusd_missing_setup_type"));
});

test("EURUSD bias requires risk-reward metrics", async () => {
  const result = await decide({
    rrTp1: undefined,
    rrFinal: undefined,
    stopLoss: null,
    takeProfits: [],
  });

  assert.equal(result.decision, "REJECT");
  assert.ok(result.blocks.includes("eurusd_missing_rr"));
});

test("hardened EURUSD bias blocks weak H1 alignment and missing trigger candle", async () => {
  const result = await decide({
    indicators: {
      ...baseCandidate().indicators,
      h1Bias: { direction: "SELL" },
      triggerCandle: { longConfirmed: false },
    },
  });

  assert.ok(result.blocks.includes("weak_h1_bias"));
  assert.ok(result.blocks.includes("missing_trigger_candle"));
});
