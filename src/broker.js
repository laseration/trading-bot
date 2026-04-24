const config = require("./config");
const { getMt5AccountState, getMt5TradeHistory, placeMt5Order, modifyMt5Position } = require("./mt5Bridge");

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
    const currentPosition = getPosition(symbol);

    if (currentPosition < 0) {
      const closeQty = Math.min(qty, Math.abs(currentPosition));
      cash -= closeQty * price + config.commissionPerTrade;
      positions[symbol] = currentPosition + closeQty;
      const remainingQty = qty - closeQty;

      if (remainingQty <= 0) {
        console.log(`BUY ${symbol} ${qty} @ ${price.toFixed(2)} (short close/partial)`);
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

      qty = remainingQty;
    }

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
    const currentPosition = getPosition(symbol);

    if (currentPosition > 0) {
      const closeQty = Math.min(qty, currentPosition);
      cash += closeQty * price - config.commissionPerTrade;
      positions[symbol] = currentPosition - closeQty;
      const remainingQty = qty - closeQty;

      if (remainingQty <= 0) {
        console.log(`SELL ${symbol} ${qty} @ ${price.toFixed(2)} (long close/partial)`);

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

      qty = remainingQty;
    }

    cash += qty * price - config.commissionPerTrade;
    positions[symbol] = getPosition(symbol) - qty;
    console.log(`SELL ${symbol} ${qty} @ ${price.toFixed(2)}`);

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
    const orderResult = await placeMt5Order(profile.symbol, side, qty, {
      expectedPrice: price,
      deviation: options.deviation,
      magic: options.magic,
      comment: options.comment,
      signalSource: options.signalSource,
      rawSignal: options.rawSignal,
      stopLoss: options.stopLoss,
      takeProfit: options.takeProfit,
    });

    return enrichMt5OrderResult(profile.symbol, side, qty, price, orderResult, options);
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

function normalizeCommentPrefix(comment) {
  const normalized = String(comment || "").trim();

  if (!normalized) {
    return "";
  }

  return normalized.slice(0, 31);
}

function sameSideDealType(side, type) {
  if (String(side || "").toUpperCase() === "BUY") {
    return Number(type) === 0;
  }

  if (String(side || "").toUpperCase() === "SELL") {
    return Number(type) === 1;
  }

  return false;
}

async function enrichMt5OrderResult(symbol, side, qty, expectedPrice, orderResult, options = {}) {
  if (!orderResult || orderResult.rejected || String(orderResult.status || "").toLowerCase() !== "ok") {
    return orderResult;
  }

  const openedQty = Number(orderResult.openedQty);

  if (!(openedQty > 0)) {
    return orderResult;
  }

  const fromEpoch = Math.floor(Date.now() / 1000) - 120;
  const commentPrefix = normalizeCommentPrefix(options.comment);
  const fillPrice = Number(orderResult.fillPrice || orderResult.validatedPrice || expectedPrice);

  try {
    const deals = await getMt5TradeHistory({
      symbol,
      fromEpoch,
      limit: 30,
    });

    const candidates = deals
      .filter((deal) => Number(deal.entry) === 0)
      .filter((deal) => sameSideDealType(side, deal.type))
      .filter((deal) => Math.abs(Number(deal.volume) - openedQty) <= 1e-8)
      .filter((deal) => {
        if (!commentPrefix) {
          return true;
        }

        return String(deal.comment || "").startsWith(commentPrefix);
      })
      .filter((deal) => {
        if (!(Number.isFinite(fillPrice) && fillPrice > 0 && Number.isFinite(Number(deal.price)))) {
          return true;
        }

        const tolerance = fillPrice >= 1 ? 0.0003 : 0.03;
        return Math.abs(Number(deal.price) - fillPrice) <= tolerance;
      })
      .sort((left, right) => Number(right.time || 0) - Number(left.time || 0));

    const matchedDeal = candidates[0];

    if (!matchedDeal) {
      return orderResult;
    }

    return {
      ...orderResult,
      orderId: matchedDeal.ticket ?? orderResult.orderId ?? null,
      ticket: matchedDeal.ticket ?? orderResult.ticket ?? null,
      positionId: matchedDeal.positionId ?? orderResult.positionId ?? null,
      dealTime: matchedDeal.time ?? null,
      dealPrice: matchedDeal.price ?? null,
    };
  } catch (error) {
    return orderResult;
  }
}

async function updatePositionProtection(symbolOrProfile, options = {}) {
  const profile = resolveProfile(symbolOrProfile);

  if (shouldUsePaper(profile)) {
    return {
      broker: "paper",
      symbol: profile.symbol,
      status: "ok",
      stopLoss: options.stopLoss ?? null,
      takeProfit: options.takeProfit ?? null,
    };
  }

  if (profile.broker === "mt5") {
    return modifyMt5Position(profile.symbol, options);
  }

  throw new Error(`Unsupported live broker: ${profile.broker}`);
}

module.exports = {
  getEquity,
  getPosition,
  placeOrder,
  getAccountState,
  updatePositionProtection,
};
