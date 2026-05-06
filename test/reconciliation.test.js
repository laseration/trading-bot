const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getReconciliationIdentityStatus,
  selectMatchedExitRows,
} = require("../src/signals/reconcileSignalResults");

function baseRecord(overrides = {}) {
  return {
    id: "sig-1",
    type: "signal",
    symbol: "EURUSD",
    direction: "BUY",
    enteredAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
    execution: {
      side: "BUY",
      qty: 1,
      remainingQty: 1,
      orderId: "order-1",
      positionId: "position-1",
    },
    reconciliation: {
      processedExitTradeKeys: [],
    },
    ...overrides,
  };
}

test("record is ignored when execution identity is missing", () => {
  const record = baseRecord({
    execution: {
      side: "BUY",
      qty: 1,
      remainingQty: 1,
      orderId: null,
      positionId: null,
    },
  });
  const status = getReconciliationIdentityStatus(record, []);

  assert.equal(status.ignoredReason, "missing_execution_identity");
  assert.equal(status.identity.source, "none");
});

test("identity can be inferred from matching entry event row", () => {
  const record = baseRecord({
    execution: {
      side: "BUY",
      qty: 1,
      remainingQty: 1,
      orderId: null,
      positionId: null,
    },
  });
  const status = getReconciliationIdentityStatus(record, [{
    symbol: "EURUSD",
    side: "BUY",
    timestamp: "2026-01-01T12:00:30.000Z",
    qty: 1,
    orderId: "entry-order",
    positionId: "entry-position",
  }]);

  assert.equal(status.ignoredReason, null);
  assert.equal(status.identity.orderId, "entry-order");
  assert.equal(status.identity.positionId, "entry-position");
  assert.equal(status.identity.source, "trade_events_entry");
});

test("exit rows match by positionId before orderId fallback", () => {
  const record = baseRecord();
  const rows = [
    {
      source: "trade-events",
      tradeKey: "wrong-position",
      timestamp: "2026-01-01T12:05:00.000Z",
      symbol: "EURUSD",
      side: "SELL",
      qty: 1,
      price: 1.101,
      orderId: "order-1",
      positionId: "other-position",
    },
    {
      source: "trade-events",
      tradeKey: "right-position",
      timestamp: "2026-01-01T12:06:00.000Z",
      symbol: "EURUSD",
      side: "SELL",
      qty: 1,
      price: 1.102,
      orderId: "other-order",
      positionId: "position-1",
    },
  ];

  const matched = selectMatchedExitRows(record, rows, {
    identity: { orderId: "order-1", positionId: "position-1", source: "tracked_execution" },
    usedExitTradeKeys: new Set(),
  });

  assert.equal(matched.length, 1);
  assert.equal(matched[0].tradeKey, "right-position");
});

test("exit rows match by orderId when positionId is unavailable", () => {
  const record = baseRecord({
    execution: {
      side: "BUY",
      qty: 1,
      remainingQty: 1,
      orderId: "order-1",
      positionId: null,
    },
  });
  const matched = selectMatchedExitRows(record, [{
    source: "trade-events",
    tradeKey: "order-match",
    timestamp: "2026-01-01T12:05:00.000Z",
    symbol: "EURUSD",
    side: "SELL",
    qty: 1,
    price: 1.101,
    orderId: "order-1",
    positionId: "",
  }], {
    identity: { orderId: "order-1", positionId: null, source: "tracked_execution" },
    usedExitTradeKeys: new Set(),
  });

  assert.equal(matched.length, 1);
  assert.equal(matched[0].tradeKey, "order-match");
});

test("duplicate exitTradeKey is not processed twice", () => {
  const usedExitTradeKeys = new Set();
  const row = {
    source: "trade-events",
    tradeKey: "exit-1",
    timestamp: "2026-01-01T12:05:00.000Z",
    symbol: "EURUSD",
    side: "SELL",
    qty: 1,
    price: 1.101,
    orderId: "order-1",
    positionId: "position-1",
  };
  const first = selectMatchedExitRows(baseRecord(), [row], {
    identity: { orderId: "order-1", positionId: "position-1", source: "tracked_execution" },
    usedExitTradeKeys,
  });
  const second = selectMatchedExitRows(baseRecord(), [row], {
    identity: { orderId: "order-1", positionId: "position-1", source: "tracked_execution" },
    usedExitTradeKeys,
  });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});
