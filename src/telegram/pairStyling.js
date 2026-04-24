const DEFAULT_STYLE = {
  emoji: 'SIGNAL',
  title: 'MARKET SIGNAL',
  accentColor: '#3ea6ff',
};

const SYMBOL_STYLES = {
  XAUUSD: {
    emoji: 'GOLD',
    title: 'GOLD SIGNAL',
    accentColor: '#f4b942',
  },
  XAGUSD: {
    emoji: 'SILVER',
    title: 'SILVER SIGNAL',
    accentColor: '#d7dee8',
  },
  'CL-OIL': {
    emoji: 'OIL',
    title: 'CRUDE OIL SIGNAL',
    accentColor: '#ff9f43',
  },
  EURUSD: {
    emoji: 'FX',
    title: 'EURUSD SIGNAL',
    accentColor: '#4ecdc4',
  },
  GBPUSD: {
    emoji: 'FX',
    title: 'GBPUSD SIGNAL',
    accentColor: '#62d26f',
  },
  USDJPY: {
    emoji: 'FX',
    title: 'USDJPY SIGNAL',
    accentColor: '#ff8a5b',
  },
  BTCUSD: {
    emoji: 'BTC',
    title: 'BITCOIN SIGNAL',
    accentColor: '#f7931a',
  },
  BTCUSDT: {
    emoji: 'BTC',
    title: 'BITCOIN SIGNAL',
    accentColor: '#f7931a',
  },
  ETHUSD: {
    emoji: 'ETH',
    title: 'ETHEREUM SIGNAL',
    accentColor: '#7f8cff',
  },
  ETHUSDT: {
    emoji: 'ETH',
    title: 'ETHEREUM SIGNAL',
    accentColor: '#7f8cff',
  },
};

function getPairStyling(symbol) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  return {
    ...DEFAULT_STYLE,
    ...(SYMBOL_STYLES[normalizedSymbol] || {}),
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 'Market';
  }

  if (Math.abs(numeric) >= 1000) {
    return numeric.toFixed(2);
  }

  if (Math.abs(numeric) >= 1) {
    return numeric.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  return numeric.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

function formatPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : 'n/a';
}

module.exports = {
  escapeHtml,
  formatPercent,
  formatPrice,
  getPairStyling,
};
