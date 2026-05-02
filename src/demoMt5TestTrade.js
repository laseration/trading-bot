const config = require('./config');
const broker = require('./broker');
const {
  getLatestMt5Quote,
  getMt5Health,
  getMt5SymbolInfo,
} = require('./mt5Bridge');
const { log, logTradeEvent } = require('./logger');

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function readEnvMode() {
  return String(process.env.TRADING_ENV || process.env.BOT_ENV || '').trim().toLowerCase();
}

function readSide() {
  const side = String(process.env.DEMO_TEST_TRADE_SIDE || 'BUY').trim().toUpperCase();

  if (!['BUY', 'SELL'].includes(side)) {
    fail('DEMO_TEST_TRADE_SIDE must be BUY or SELL', { side });
  }

  return side;
}

function readQty() {
  const qty = Number(process.env.DEMO_TEST_TRADE_QTY || 0.01);

  if (!(Number.isFinite(qty) && qty > 0)) {
    fail('DEMO_TEST_TRADE_QTY must be a positive number', { qty: process.env.DEMO_TEST_TRADE_QTY });
  }

  return Number(qty.toFixed(2));
}

function roundPrice(value, digits) {
  const places = Number.isInteger(digits) && digits >= 0 ? digits : 5;
  return Number(Number(value).toFixed(places));
}

function resolveEntryPrice(side, quote) {
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const price = Number(quote.price);

  if (side === 'BUY' && Number.isFinite(ask) && ask > 0) {
    return ask;
  }

  if (side === 'SELL' && Number.isFinite(bid) && bid > 0) {
    return bid;
  }

  if (Number.isFinite(price) && price > 0) {
    return price;
  }

  fail('MT5 quote did not contain a usable execution price', { quote });
}

function resolveProtection(side, entryPrice, symbolInfo = {}) {
  const digits = Number(symbolInfo.digits);
  const point = Number(symbolInfo.point);
  const stopsLevel = Number(symbolInfo.stopsLevel);
  const minStopDistance = Number.isFinite(point) && point > 0
    ? Math.max((Number.isFinite(stopsLevel) ? stopsLevel : 0) * point, 100 * point)
    : Math.max(entryPrice * 0.001, 0.001);
  const protectionDistance = Math.max(minStopDistance, entryPrice * 0.001);

  if (side === 'BUY') {
    return {
      stopLoss: roundPrice(entryPrice - protectionDistance, digits),
      takeProfit: roundPrice(entryPrice + protectionDistance, digits),
    };
  }

  return {
    stopLoss: roundPrice(entryPrice + protectionDistance, digits),
    takeProfit: roundPrice(entryPrice - protectionDistance, digits),
  };
}

function assertFreshQuote(quote) {
  const quoteEpochSeconds = Number(quote.time);

  if (!(Number.isFinite(quoteEpochSeconds) && quoteEpochSeconds > 0)) {
    fail('MT5 quote is missing a broker timestamp', { quote });
  }

  const quoteTimestampMs = quoteEpochSeconds * 1000;
  const quoteAgeMs = Math.max(0, Date.now() - quoteTimestampMs);
  const futureSkewMs = Math.max(0, quoteTimestampMs - Date.now());

  if (
    Number.isFinite(config.mt5Bridge.maxFutureQuoteSkewMs)
    && config.mt5Bridge.maxFutureQuoteSkewMs > 0
    && futureSkewMs > config.mt5Bridge.maxFutureQuoteSkewMs
  ) {
    fail('MT5 quote timestamp is too far in the future', {
      quoteAgeMs,
      futureSkewMs,
      maxFutureQuoteSkewMs: config.mt5Bridge.maxFutureQuoteSkewMs,
    });
  }

  if (
    Number.isFinite(config.mt5Bridge.maxQuoteAgeMs)
    && config.mt5Bridge.maxQuoteAgeMs > 0
    && quoteAgeMs > config.mt5Bridge.maxQuoteAgeMs
  ) {
    fail('MT5 quote is stale', {
      quoteAgeMs,
      maxQuoteAgeMs: config.mt5Bridge.maxQuoteAgeMs,
      quoteTime: new Date(quoteTimestampMs).toISOString(),
    });
  }

  return { quoteAgeMs, futureSkewMs };
}

async function main() {
  const envMode = readEnvMode();

  if (envMode !== 'demo') {
    fail('Refusing MT5 test trade outside TRADING_ENV=demo', { envMode });
  }

  if (config.paperTradingMode !== false) {
    fail('Refusing MT5 test trade while paper trading mode is enabled');
  }

  if (config.mt5Bridge.enabled !== true) {
    fail('Refusing MT5 test trade because MT5 bridge is not enabled');
  }

  const health = await getMt5Health();

  if (!health || health.status !== 'ok' || health.connected !== true) {
    fail('Refusing MT5 test trade because bridge health is not connected', { health });
  }

  if (!String(health.server || '').toLowerCase().includes('demo')) {
    fail('Refusing MT5 test trade because MT5 server does not look like demo', {
      server: health.server,
      accountLogin: health.accountLogin,
    });
  }

  const symbol = String(process.env.DEMO_TEST_TRADE_SYMBOL || 'EURUSD').trim().toUpperCase();
  const side = readSide();
  const qty = readQty();
  const quote = await getLatestMt5Quote(symbol);
  const freshness = assertFreshQuote(quote);
  const symbolInfo = await getMt5SymbolInfo(symbol);
  const entryPrice = resolveEntryPrice(side, quote);
  const protection = resolveProtection(side, entryPrice, symbolInfo);
  const profile = {
    symbol,
    broker: 'mt5',
    dataSource: 'mt5',
    signalSource: 'demo-connectivity-test',
  };
  const comment = 'demo-connectivity-test';

  log(
    `[DEMO_TEST_TRADE] Submitting one MT5 demo connectivity test `
    + `symbol=${symbol} side=${side} qty=${qty} price=${entryPrice} `
    + `stopLoss=${protection.stopLoss} takeProfit=${protection.takeProfit}`,
  );
  logTradeEvent({
    timestamp: new Date().toISOString(),
    symbol,
    event_type: 'order_placed',
    side,
    qty,
    price: entryPrice,
    position: '',
    position_id: '',
    order_id: '',
    status: 'submitted',
    notes: comment,
  });

  const orderResult = await broker.placeOrder(profile, side, qty, entryPrice, {
    comment,
    signalSource: 'demo-connectivity-test',
    rawSignal: comment,
    stopLoss: protection.stopLoss,
    takeProfit: protection.takeProfit,
  });
  const executionPrice = Number(orderResult && (orderResult.fillPrice || orderResult.validatedPrice)) || entryPrice;
  const account = await broker.getAccountState(profile, executionPrice);

  logTradeEvent({
    timestamp: new Date().toISOString(),
    symbol,
    event_type: orderResult && orderResult.rejected ? 'order_rejected' : 'position_opened',
    side,
    qty,
    price: executionPrice,
    position: account.position,
    position_id: orderResult && (orderResult.positionId ?? ''),
    order_id: orderResult && (orderResult.orderId ?? orderResult.ticket ?? ''),
    status: orderResult && (orderResult.status || (orderResult.rejected ? 'rejected' : 'unknown')),
    notes: comment,
  });

  const result = {
    envMode,
    symbol,
    side,
    qty,
    quote,
    quoteFreshness: freshness,
    symbolInfo,
    stopLoss: protection.stopLoss,
    takeProfit: protection.takeProfit,
    comment,
    health: {
      status: health.status,
      connected: health.connected,
      accountLogin: health.accountLogin,
      server: health.server,
      company: health.company,
    },
    orderResult,
    account,
  };

  log(
    `[DEMO_TEST_TRADE] Result status=${orderResult && orderResult.status} `
    + `ticket=${orderResult && (orderResult.ticket ?? orderResult.orderId ?? 'na')} `
    + `positionId=${orderResult && (orderResult.positionId ?? 'na')}`,
  );
  console.log(JSON.stringify(result, null, 2));

  if (orderResult && orderResult.rejected) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const payload = {
    error: error.message,
    details: error.details || null,
  };

  log(`[DEMO_TEST_TRADE] Refused: ${error.message}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
