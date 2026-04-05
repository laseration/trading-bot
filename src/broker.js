const config = require("./config");
const { getMt5AccountState, placeMt5Order } = require("./mt5Bridge");

let cash = 10000;
const positions = {};

function resolveProfile(symbolOrProfile) {
  if (symbolOrProfile && typeof symbolOrProfile === "object") {
    return symbolOrProfile;
  }

  return {
    symbol: symbolOrProfile || "DEFAULT",
    broker: config.paperTradingMode ? "paper" : "alpaca",
  };
}

function shouldUsePaper(profile) {
  return config.paperTradingMode || !profile.broker || profile.broker === "paper";
}

function getEquity(symbol = "DEFAULT", currentPrice = 100) {
  return cash + getPosition(symbol) * currentPrice;
}

function getPosition(symbol = "DEFAULT") {
  return positions[symbol] || 0;
}

function placePaperOrder(symbol, side, qty, price) {
  if (qty <= 0) {
    console.log("No order placed: qty <= 0");
    return {
      broker: "paper",
      symbol,
      side,
      qty,
      expectedPrice: price,
      validatedPrice: price,
      fillPrice: price,
      status: "rejected",
      rejected: true,
      reason: "qty <= 0",
    };
  }

  if (side === "BUY") {
    const cost = qty * price + config.commissionPerTrade;
    if (cost > cash) {
      console.log("Not enough cash to buy");
      return {
        broker: "paper",
        symbol,
        side,
        qty,
        expectedPrice: price,
        validatedPrice: price,
        fillPrice: price,
        status: "rejected",
        rejected: true,
        reason: "Not enough cash to buy",
      };
    }
    cash -= cost;
    positions[symbol] = getPosition(symbol) + qty;
    console.log(`BUY ${symbol} ${qty} @ ${price.toFixed(2)}`);
  }

  if (side === "SELL") {
    const sellQty = Math.min(qty, getPosition(symbol));
    cash += sellQty * price - config.commissionPerTrade;
    positions[symbol] = getPosition(symbol) - sellQty;
    console.log(`SELL ${symbol} ${sellQty} @ ${price.toFixed(2)}`);

    return {
      broker: "paper",
      symbol,
      side,
      qty: sellQty,
      expectedPrice: price,
      validatedPrice: price,
      fillPrice: price,
      status: "filled",
    };
  }

  return {
    broker: "paper",
    symbol,
    side,
    qty,
    expectedPrice: price,
    validatedPrice: price,
    fillPrice: price,
    status: "filled",
  };
}

function getPaperAccountState(symbol, currentPrice = 100) {
  return {
    cash,
    position: getPosition(symbol),
    equity: getEquity(symbol, currentPrice),
  };
}

async function placeOrder(symbolOrProfile, side, qty, price, options = {}) {
  const profile = resolveProfile(symbolOrProfile);

  if (shouldUsePaper(profile)) {
    return placePaperOrder(profile.symbol, side, qty, price);
  }

  if (profile.broker === "mt5") {
    return placeMt5Order(profile.symbol, side, qty, {
      expectedPrice: price,
      deviation: options.deviation,
      magic: options.magic,
      comment: options.comment,
      signalSource: options.signalSource,
      rawSignal: options.rawSignal,
    });
  }

  throw new Error(`Unsupported live broker: ${profile.broker}`);
}

async function getAccountState(symbolOrProfile, currentPrice = 100) {
  const profile = resolveProfile(symbolOrProfile);

  if (shouldUsePaper(profile)) {
    return getPaperAccountState(profile.symbol, currentPrice);
  }

  if (profile.broker === "mt5") {
    return getMt5AccountState(profile.symbol, currentPrice);
  }

  throw new Error(`Unsupported live broker: ${profile.broker}`);
}

module.exports = {
  getEquity,
  getPosition,
  placeOrder,
  getAccountState,
};
