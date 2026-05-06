const config = require('./config');
const { log } = require('./logger');

const TIMED_REQUEST_PATHS = new Set(['/bars', '/account', '/history']);
const NATIVE_REQUEST_PATHS = new Set(['/quote', '/account', '/symbols', '/symbol-info', '/history', '/bars', '/order', '/modify']);
const barsCache = new Map();
const barsInFlight = new Map();
let nativeRequestQueue = Promise.resolve();

function getBridgeBaseUrl() {
  return String(config.mt5Bridge.baseUrl || '').replace(/\/+$/, '');
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describePayload(payload = {}) {
  return ['symbol', 'timeframe', 'count', 'fromEpoch', 'toEpoch', 'limit']
    .filter((key) => payload[key] != null && payload[key] !== '')
    .map((key) => `${key}=${payload[key]}`)
    .join(' ');
}

function shouldSerializeRequest(method, path) {
  return Boolean(config.mt5Bridge.serializeRequests)
    && method !== 'GET'
    && NATIVE_REQUEST_PATHS.has(path);
}

async function runQueuedNativeRequest(operation) {
  const previous = nativeRequestQueue.catch(() => {});
  let release;
  nativeRequestQueue = new Promise((resolve) => {
    release = resolve;
  });

  const queuedAt = Date.now();
  await previous;

  try {
    return await operation(Date.now() - queuedAt);
  } finally {
    release();
  }
}

function logTimedRequest(requestLabel, status, startedAt, queueMs, detail = '') {
  const durationMs = Date.now() - startedAt;
  log(
    `[MT5_BRIDGE] ${requestLabel} ${status}`
    + ` durationMs=${durationMs}`
    + ` queueMs=${queueMs || 0}`
    + `${detail ? ` ${detail}` : ''}`,
  );
}

async function requestBridge(path, options = {}) {
  if (!config.mt5Bridge.enabled) {
    throw new Error('MT5 bridge is not enabled');
  }

  const baseUrl = getBridgeBaseUrl();

  if (!baseUrl) {
    throw new Error('Missing MT5 bridge base URL');
  }

  const method = options.method || 'POST';
  const payload = options.payload;
  const payloadLabel = payload ? describePayload(payload) : '';
  const requestLabel = `${method} ${path}${payloadLabel ? ` ${payloadLabel}` : ''}`;
  const shouldTimeRequest = TIMED_REQUEST_PATHS.has(path);

  const executeRequest = async (queueMs = 0) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.mt5Bridge.timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: method === 'GET'
          ? undefined
          : {
              'Content-Type': 'application/json',
            },
        body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`MT5 bridge request failed: ${response.status} ${body}`);
      }

      const json = await response.json();

      if (shouldTimeRequest) {
        logTimedRequest(requestLabel, 'ok', startedAt, queueMs);
      }

      return json;
    } catch (err) {
      let classifiedError = err;

      if (err && err.name === 'AbortError') {
        classifiedError = new Error(`MT5 bridge request timeout/abort after ${config.mt5Bridge.timeoutMs}ms: ${requestLabel}`);
      } else if (/fetch failed|ECONNREFUSED|Unable to connect/i.test(String(err && err.message || ''))) {
        classifiedError = new Error(`MT5 bridge unreachable: ${requestLabel}: ${err.message}`);
      }

      if (shouldTimeRequest) {
        logTimedRequest(requestLabel, 'failed', startedAt, queueMs, `error=${classifiedError.message}`);
      }

      throw classifiedError;
    } finally {
      clearTimeout(timeout);
    }
  };

  return shouldSerializeRequest(method, path)
    ? runQueuedNativeRequest(executeRequest)
    : executeRequest(0);
}

function readQuote(data, symbol) {
  const bid = readNumber(data.bid);
  const ask = readNumber(data.ask);
  const last = readNumber(data.last);
  const time = readNumber(data.time);
  const derivedMid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const price = readNumber(data.price) ?? derivedMid ?? last;

  if (!Number.isFinite(price)) {
    throw new Error(`MT5 bridge did not return a numeric price for ${symbol}`);
  }

  return {
    ...data,
    bid,
    ask,
    last,
    time,
    price,
  };
}

async function getLatestMt5Quote(symbol) {
  const data = await requestBridge('/quote', {
    payload: { symbol },
  });

  return readQuote(data, symbol);
}

async function getLatestMt5Price(symbol) {
  const quote = await getLatestMt5Quote(symbol);
  return quote.price;
}

async function placeMt5Order(symbol, side, qty, options = {}) {
  return requestBridge('/order', {
    payload: {
      symbol,
      side,
      qty,
      expectedPrice: options.expectedPrice,
      deviation: options.deviation ?? config.mt5Bridge.deviationPoints,
      magic: options.magic ?? config.mt5Bridge.magic,
      comment: options.comment,
      signalSource: options.signalSource,
      rawSignal: options.rawSignal,
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
    },
  });
}

async function modifyMt5Position(symbol, options = {}) {
  return requestBridge('/modify', {
    payload: {
      symbol,
      side: options.side,
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
    },
  });
}

async function getMt5SymbolInfo(symbol) {
  return requestBridge('/symbol-info', {
    payload: { symbol },
  });
}

async function getMt5AccountState(symbol, currentPrice = 0) {
  const data = await requestBridge('/account', {
    payload: { symbol, currentPrice },
  });

  return {
    cash: readNumber(data.cash ?? data.marginFree ?? data.balance) ?? 0,
    position: readNumber(data.position ?? data.volume) ?? 0,
    equity: readNumber(data.equity ?? data.balance) ?? 0,
    balance: readNumber(data.balance) ?? 0,
    marginFree: readNumber(data.marginFree) ?? 0,
    raw: data,
  };
}

async function getMt5Health() {
  return requestBridge('/health', {
    method: 'GET',
  });
}

async function getMt5TradeHistory({ symbol = '', fromEpoch, toEpoch, limit = 50 } = {}) {
  const data = await requestBridge('/history', {
    payload: {
      symbol,
      fromEpoch,
      toEpoch,
      limit,
    },
  });

  return Array.isArray(data.deals)
    ? data.deals.map((deal) => ({
        ...deal,
        ticket: readNumber(deal.ticket) ?? deal.ticket,
        entry: readNumber(deal.entry) ?? deal.entry,
        type: readNumber(deal.type) ?? deal.type,
        volume: readNumber(deal.volume) ?? deal.volume,
        price: readNumber(deal.price) ?? deal.price,
        profit: readNumber(deal.profit) ?? deal.profit,
        time: readNumber(deal.time) ?? deal.time,
        magic: readNumber(deal.magic) ?? deal.magic,
        positionId: readNumber(deal.positionId) ?? deal.positionId,
      }))
    : [];
}

async function getMt5Bars({ symbol, timeframe = 'M15', count = 250 } = {}) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const normalizedTimeframe = String(timeframe || 'M15').toUpperCase();
  const normalizedCount = Number(count || 250);
  const cacheKey = `${normalizedSymbol}|${normalizedTimeframe}|${normalizedCount}`;
  const cacheTtlMs = Math.max(0, Number(config.mt5Bridge.barsCacheTtlMs || 0));
  const cached = barsCache.get(cacheKey);

  if (cached && cacheTtlMs > 0 && Date.now() - cached.fetchedAt <= cacheTtlMs) {
    log(`[MT5_BRIDGE] POST /bars symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} count=${normalizedCount} cache=hit ageMs=${Date.now() - cached.fetchedAt}`);
    return cached.bars.map((bar) => ({ ...bar }));
  }

  if (barsInFlight.has(cacheKey)) {
    log(`[MT5_BRIDGE] POST /bars symbol=${normalizedSymbol} timeframe=${normalizedTimeframe} count=${normalizedCount} cache=in_flight`);
    const bars = await barsInFlight.get(cacheKey);
    return bars.map((bar) => ({ ...bar }));
  }

  const fetchBars = (async () => {
    const data = await requestBridge('/bars', {
      payload: {
        symbol: normalizedSymbol,
        timeframe: normalizedTimeframe,
        count: normalizedCount,
      },
    });

    const bars = Array.isArray(data.bars)
      ? data.bars.map((bar) => ({
          ...bar,
          time: readNumber(bar.time) ?? bar.time,
          open: readNumber(bar.open) ?? bar.open,
          high: readNumber(bar.high) ?? bar.high,
          low: readNumber(bar.low) ?? bar.low,
          close: readNumber(bar.close) ?? bar.close,
          tickVolume: readNumber(bar.tickVolume) ?? bar.tickVolume,
        }))
      : [];

    if (cacheTtlMs > 0) {
      barsCache.set(cacheKey, {
        fetchedAt: Date.now(),
        bars,
      });
    }

    return bars;
  })();

  barsInFlight.set(cacheKey, fetchBars);

  try {
    const bars = await fetchBars;
    return bars.map((bar) => ({ ...bar }));
  } finally {
    barsInFlight.delete(cacheKey);
  }
}

module.exports = {
  getLatestMt5Quote,
  getLatestMt5Price,
  placeMt5Order,
  modifyMt5Position,
  getMt5SymbolInfo,
  getMt5AccountState,
  getMt5Health,
  getMt5TradeHistory,
  getMt5Bars,
};
