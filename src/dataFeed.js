const config = require('./config');
const { getLatestMt5Price } = require('./mt5Bridge');

function getHistoricalCloses() {
  return Array.from({ length: 100 }, () => 100 + Math.random() * 10);
}

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

async function getLatestPrice(symbolOrProfile) {
  const profile = resolveProfile(symbolOrProfile);

  if (!profile.symbol) {
    throw new Error('Missing symbol');
  }

  if (profile.dataSource === 'mt5') {
    return getLatestMt5Price(profile.symbol);
  }

  if (profile.dataSource === 'mock') {
    return 100 + Math.random() * 10;
  }

  return getLatestAlpacaPrice(profile.symbol);
}

module.exports = { getHistoricalCloses, getLatestPrice };
