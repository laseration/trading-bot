const config = require('./config');

function getBridgeBaseUrl() {
  return String(config.mt5Bridge.baseUrl || '').replace(/\/+$/, '');
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function requestBridge(path, options = {}) {
  if (!config.mt5Bridge.enabled) {
    throw new Error('MT5 bridge is not enabled');
  }

  const baseUrl = getBridgeBaseUrl();

  if (!baseUrl) {
    throw new Error('Missing MT5 bridge base URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.mt5Bridge.timeoutMs);
  const method = options.method || 'POST';
  const payload = options.payload;

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

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function readQuote(data, symbol) {
  const bid = readNumber(data.bid);
  const ask = readNumber(data.ask);
  const last = readNumber(data.last);
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
    },
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

module.exports = {
  getLatestMt5Quote,
  getLatestMt5Price,
  placeMt5Order,
  getMt5AccountState,
  getMt5Health,
};
