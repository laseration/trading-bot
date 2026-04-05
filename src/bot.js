const config = require('./config');
const { log, logTrade, logEquity } = require('./logger');
const { getLatestPrice } = require('./dataFeed');
const { generateSignal } = require('./strategy');
const { calculatePositionSize } = require('./risk');
const broker = require('./broker');

const pricesBySymbol = {};
const startingEquityBySymbol = {};
const openTradeCostBySymbol = {};

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

function normalizeSignal(signal) {
  if (typeof signal !== 'string') {
    return 'HOLD';
  }

  const upper = signal.toUpperCase();
  return ['BUY', 'SELL', 'HOLD'].includes(upper) ? upper : 'HOLD';
}

function getExecutionPrice(orderResult, fallbackPrice) {
  const fillPrice = Number(orderResult && orderResult.fillPrice);
  const validatedPrice = Number(orderResult && orderResult.validatedPrice);

  if (Number.isFinite(fillPrice) && fillPrice > 0) {
    return fillPrice;
  }

  if (Number.isFinite(validatedPrice) && validatedPrice > 0) {
    return validatedPrice;
  }

  return fallbackPrice;
}

function logOrderPriceDetails(symbol, referencePrice, orderResult) {
  if (!orderResult) {
    return;
  }

  if (Number.isFinite(Number(orderResult.validatedPrice))) {
    log(`[${symbol}] Broker validation price: ${Number(orderResult.validatedPrice)}`);
  }

  if (Number.isFinite(Number(orderResult.fillPrice))) {
    log(`[${symbol}] Broker fill price: ${Number(orderResult.fillPrice)}`);
  }

  if (Number.isFinite(Number(orderResult.expectedPrice)) && Number(orderResult.expectedPrice) !== referencePrice) {
    log(`[${symbol}] Bot reference price: ${Number(orderResult.expectedPrice)}`);
  }
}

async function runBot(symbolOrProfile, options = {}) {
  const profile = resolveProfile(symbolOrProfile);
  const symbol = profile.symbol;
  const cycleKey = profile.id || symbol;
  const price = options.price ?? await getLatestPrice(profile);
  const prices = pricesBySymbol[symbol] || [];
  prices.push(price);
  pricesBySymbol[symbol] = prices;

  if (prices.length > 100) {
    prices.shift();
  }

  const signal = normalizeSignal(options.signal ?? generateSignal(prices));
  const signalSource = options.signalSource || profile.signalSource || 'strategy';

  log(`------ BOT STEP ${symbol} ------`);
  log(`[${symbol}] Price: ${price}`);
  log(`[${symbol}] Signal: ${signal}`);
  log(`[${symbol}] Signal source: ${signalSource}`);

  const account = await broker.getAccountState(profile, price);
  const startingEquity = startingEquityBySymbol[cycleKey];

  if (startingEquity == null) {
    startingEquityBySymbol[cycleKey] = account.equity;
    log(`[${symbol}] Starting equity set to: ${startingEquityBySymbol[cycleKey]}`);
  }

  const currentStartingEquity = startingEquityBySymbol[cycleKey];
  const drawdown = (currentStartingEquity - account.equity) / currentStartingEquity;

  if (drawdown >= config.risk.maxDrawdownPct) {
    log(`[${symbol}] Kill switch triggered. Drawdown: ${(drawdown * 100).toFixed(2)}%`);
    return;
  }

  if (signal === "BUY" && account.position === 0) {
    const size = calculatePositionSize(account.cash, price);

    if (size > 0) {
      const orderQty = options.qty ?? size;
      const orderResult = await broker.placeOrder(profile, "BUY", orderQty, price, {
        signalSource,
        rawSignal: options.rawSignal,
        comment: `${config.mt5Bridge.commentPrefix}:${symbol}:BUY`,
      });

      if (orderResult && orderResult.rejected) {
        log(`[${symbol}] BUY rejected: ${orderResult.reason}`);
      } else {
        const executionPrice = getExecutionPrice(orderResult, price);
        openTradeCostBySymbol[symbol] = orderQty * executionPrice + config.commissionPerTrade;
        logOrderPriceDetails(symbol, price, orderResult);
        log(`[${symbol}] BUY executed: size=${orderQty} price=${executionPrice}`);
        const tradeAccount = await broker.getAccountState(profile, executionPrice);
        logTrade({
          timestamp: new Date().toISOString(),
          symbol,
          side: "BUY",
          qty: orderQty,
          price: executionPrice,
          pnl: "",
          cash: tradeAccount.cash,
          position: tradeAccount.position,
          equity: tradeAccount.equity,
        });
      }
    } else {
      log(`[${symbol}] BUY skipped: position size was 0`);
    }
  } else if (signal === "SELL" && account.position > 0) {
    const qty = options.qty ?? account.position;
    const openTradeCost = openTradeCostBySymbol[symbol];
    const orderResult = await broker.placeOrder(profile, "SELL", qty, price, {
      signalSource,
      rawSignal: options.rawSignal,
      comment: `${config.mt5Bridge.commentPrefix}:${symbol}:SELL`,
    });

    if (orderResult && orderResult.rejected) {
      log(`[${symbol}] SELL rejected: ${orderResult.reason}`);
    } else {
      const executionPrice = getExecutionPrice(orderResult, price);
      const pnl = openTradeCost == null
        ? ""
        : qty * executionPrice - config.commissionPerTrade - openTradeCost;

      logOrderPriceDetails(symbol, price, orderResult);
      log(`[${symbol}] SELL executed: size=${qty} price=${executionPrice}`);
      if (pnl !== "") {
        log(`[${symbol}] Trade PnL: ${pnl.toFixed(2)}`);
      }
      const tradeAccount = await broker.getAccountState(profile, executionPrice);
      logTrade({
        timestamp: new Date().toISOString(),
        symbol,
        side: "SELL",
        qty,
        price: executionPrice,
        pnl,
        cash: tradeAccount.cash,
        position: tradeAccount.position,
        equity: tradeAccount.equity,
      });
      openTradeCostBySymbol[symbol] = null;
    }
  } else {
    log(`[${symbol}] No trade`);
  }

  const updatedAccount = await broker.getAccountState(profile, price);
  log(`[${symbol}] Cash: ${updatedAccount.cash}`);
  log(`[${symbol}] Position: ${updatedAccount.position}`);
  log(`[${symbol}] Equity: ${updatedAccount.equity}`);
  logEquity({
    timestamp: new Date().toISOString(),
    symbol,
    cash: updatedAccount.cash,
    position: updatedAccount.position,
    equity: updatedAccount.equity,
  });
}

module.exports = { runBot };
