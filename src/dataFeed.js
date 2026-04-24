const config = require('./config');
const { getLatestMt5Price, getMt5Bars } = require('./mt5Bridge');

const alphaVantageCache = new Map();
let alphaVantageLastRequestAt = 0;

function resolveProfile(symbolOrProfile) {
  if (symbolOrProfile && typeof symbolOrProfile === 'object') {
    return symbolOrProfile;
  }

  return {
    symbol: symbolOrProfile,
    market: typeof symbolOrProfile === 'string' && symbolOrProfile.includes('/') ? 'crypto' : 'stock',
    dataSource: 'alpaca',
    signalSource: 'strategy',
    broker: config.paperTradingMode ? 'paper' : 'alpaca',
  };
}

function buildMockBars(count = config.strategy.lookbackBars) {
  const bars = [];
  let price = 100;
  let time = Date.now() - count * 15 * 60 * 1000;

  for (let index = 0; index < count; index += 1) {
    const drift = (Math.random() - 0.5) * 1.5;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + Math.random() * 0.6;
    const low = Math.min(open, close) - Math.random() * 0.6;

    bars.push({
      time: Math.floor(time / 1000),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      tickVolume: 100 + Math.floor(Math.random() * 900),
    });

    price = close;
    time += 15 * 60 * 1000;
  }

  return bars;
}

async function getLatestAlpacaPrice(symbol) {
  const { apiKey, secretKey, dataBaseUrl } = config.alpaca;

  if (!apiKey || !secretKey) {
    throw new Error('Missing Alpaca API credentials in environment');
  }

  if (!symbol) {
    throw new Error('Missing symbol');
  }

  const isCrypto = symbol.includes('/');
  let url;

  if (isCrypto) {
    url = `${dataBaseUrl}/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(symbol)}`;
  } else {
    url = `${dataBaseUrl}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`;
  }

  const response = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': secretKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca request failed for ${symbol}: ${response.status} ${body}`);
  }

  const data = await response.json();

  if (isCrypto) {
    const trade = data.trades && data.trades[symbol];

    if (!trade || typeof trade.p !== 'number') {
      throw new Error(`No crypto trade price found for ${symbol}`);
    }

    return trade.p;
  }

  if (!data.trade || typeof data.trade.p !== 'number') {
    throw new Error(`No stock trade price found for ${symbol}`);
  }

  return data.trade.p;
}

function parseForexSymbol(symbol) {
  const normalized = String(symbol || '').toUpperCase();

  if (!/^[A-Z]{6}$/.test(normalized)) {
    return null;
  }

  return {
    fromSymbol: normalized.slice(0, 3),
    toSymbol: normalized.slice(3, 6),
  };
}

function normalizeAlphaVantageTimeframe(timeframe) {
  const normalized = String(timeframe || config.alphaVantage.preferredTimeframe || 'D1').toUpperCase();

  if (normalized === 'W1' || normalized === '1W' || normalized === 'WEEKLY') {
    return 'W1';
  }

  if (normalized === 'MN' || normalized === 'M1' || normalized === 'MONTHLY') {
    return 'MN';
  }

  return 'D1';
}

function getAlphaVantageFunction(timeframe) {
  if (timeframe === 'W1') {
    return 'FX_WEEKLY';
  }

  if (timeframe === 'MN') {
    return 'FX_MONTHLY';
  }

  return 'FX_DAILY';
}

function getAlphaVantageSeriesKey(payload) {
  return Object.keys(payload || {}).find((key) => /Time Series FX/i.test(key));
}

function getTimeStepMs(timeframe) {
  if (timeframe === 'W1') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (timeframe === 'MN') {
    return 30 * 24 * 60 * 60 * 1000;
  }

  return 24 * 60 * 60 * 1000;
}

function parseAlphaVantageBars(payload, timeframe, count) {
  const seriesKey = getAlphaVantageSeriesKey(payload);

  if (!seriesKey || !payload[seriesKey]) {
    const note = payload && (payload.Note || payload.Information || payload['Error Message']);
    throw new Error(`Alpha Vantage did not return forex bars${note ? `: ${note}` : ''}`);
  }

  const series = payload[seriesKey];
  const keys = Object.keys(series).sort((left, right) => Date.parse(right) - Date.parse(left));
  const stepMs = getTimeStepMs(timeframe);

  return keys.slice(0, count).map((timestamp) => {
    const bar = series[timestamp] || {};
    return {
      time: Math.floor(new Date(timestamp).getTime() / 1000) || Math.floor(Date.now() / 1000),
      open: Number(bar['1. open']),
      high: Number(bar['2. high']),
      low: Number(bar['3. low']),
      close: Number(bar['4. close']),
      tickVolume: 0,
      sourceTimeframeMs: stepMs,
    };
  }).reverse();
}

async function throttleAlphaVantage() {
  const minSpacingMs = Number(config.alphaVantage.minRequestSpacingMs || 0);
  const waitMs = Math.max(0, alphaVantageLastRequestAt + minSpacingMs - Date.now());

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  alphaVantageLastRequestAt = Date.now();
}

async function getAlphaVantageForexBars(symbol, options = {}) {
  const parsedSymbol = parseForexSymbol(symbol);

  if (!parsedSymbol) {
    throw new Error(`Alpha Vantage forex market data only supports 6-letter FX pairs. Unsupported symbol: ${symbol}`);
  }

  const timeframe = normalizeAlphaVantageTimeframe(options.timeframe);
  const count = Number(options.count || config.strategy.lookbackBars);
  const cacheKey = `${String(symbol).toUpperCase()}:${timeframe}:${count}`;
  const cached = alphaVantageCache.get(cacheKey);
  const cacheAgeMs = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;

  if (cached && cacheAgeMs < Number(config.alphaVantage.marketDataCacheMs || 0)) {
    return cached.bars;
  }

  if (!config.alphaVantage.apiKey) {
    throw new Error('Missing ALPHA_VANTAGE_API_KEY for market data feed');
  }

  await throttleAlphaVantage();

  const response = await fetch(`${String(config.alphaVantage.baseUrl || '').replace(/\/+$/, '')}?${new URLSearchParams({
    function: getAlphaVantageFunction(timeframe),
    from_symbol: parsedSymbol.fromSymbol,
    to_symbol: parsedSymbol.toSymbol,
    outputsize: config.alphaVantage.forexOutputSize || 'compact',
    apikey: config.alphaVantage.apiKey,
  }).toString()}`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpha Vantage request failed for ${symbol}: ${response.status} ${body}`);
  }

  const payload = await response.json();
  const bars = parseAlphaVantageBars(payload, timeframe, count);
  alphaVantageCache.set(cacheKey, {
    fetchedAt: Date.now(),
    bars,
  });
  return bars;
}

async function getHistoricalBars(symbolOrProfile, options = {}) {
  const profile = resolveProfile(symbolOrProfile);
  const count = Number(options.count || config.strategy.lookbackBars);
  const timeframe = options.timeframe || config.strategy.timeframe;

  if (!profile.symbol) {
    throw new Error('Missing symbol');
  }

  if (profile.dataSource === 'mt5') {
    return getMt5Bars({
      symbol: profile.symbol,
      timeframe,
      count,
    });
  }

  if (profile.dataSource === 'alpha_vantage') {
    return getAlphaVantageForexBars(profile.symbol, {
      timeframe,
      count,
    });
  }

  return buildMockBars(count);
}

async function getHistoricalCloses(symbolOrProfile, options = {}) {
  const bars = await getHistoricalBars(symbolOrProfile, options);
  return bars.map((bar) => Number(bar.close)).filter(Number.isFinite);
}

async function getLatestPrice(symbolOrProfile) {
  const profile = resolveProfile(symbolOrProfile);

  if (!profile.symbol) {
    throw new Error('Missing symbol');
  }

  if (profile.dataSource === 'mt5') {
    return getLatestMt5Price(profile.symbol);
  }

  if (profile.dataSource === 'alpha_vantage') {
    const bars = await getAlphaVantageForexBars(profile.symbol, {
      timeframe: config.alphaVantage.preferredTimeframe || 'D1',
      count: 1,
    });

    if (!Array.isArray(bars) || bars.length === 0 || !Number.isFinite(Number(bars[bars.length - 1].close))) {
      throw new Error(`Alpha Vantage did not return a usable latest close for ${profile.symbol}`);
    }

    return Number(bars[bars.length - 1].close);
  }

  if (profile.dataSource === 'mock') {
    const bars = buildMockBars(1);
    return bars[0].close;
  }

  return getLatestAlpacaPrice(profile.symbol);
}

module.exports = {
  getHistoricalBars,
  getHistoricalCloses,
  getLatestPrice,
};
