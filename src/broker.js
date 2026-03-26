let cash = 10000;
let position = 0;

function getEquity(currentPrice = 100) {
  return cash + position * currentPrice;
}

function getPosition() {
  return position;
}

function placeOrder(side, qty, price) {
  if (qty <= 0) {
    console.log("No order placed: qty <= 0");
    return;
  }

  if (side === "BUY") {
    const cost = qty * price;
    if (cost > cash) {
      console.log("Not enough cash to buy");
      return;
    }
    cash -= cost;
    position += qty;
    console.log(`BUY ${qty} @ ${price.toFixed(2)}`);
  }

  if (side === "SELL") {
    const sellQty = Math.min(qty, position);
    cash += sellQty * price;
    position -= sellQty;
    console.log(`SELL ${sellQty} @ ${price.toFixed(2)}`);
  }
}

function getAccountState(currentPrice = 100) {
  return {
    cash,
    position,
    equity: getEquity(currentPrice),
  };
}

module.exports = {
  getEquity,
  getPosition,
  placeOrder,
  getAccountState,
};