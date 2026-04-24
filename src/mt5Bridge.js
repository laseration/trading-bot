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
  const data = await requestBridge('/bars', {
    payload: {
      symbol,
      timeframe,
      count,
    },
  });

  return Array.isArray(data.bars)
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
