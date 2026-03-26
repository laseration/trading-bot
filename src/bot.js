const { generateSignal } = require("./strategy");
const { positionSize } = require("./risk");
const dataFeed = require("./dataFeed");
const broker = require("./broker");

function runBot() {
  const closes = dataFeed.getHistoricalCloses();
  const price = dataFeed.getLatestPrice();

  const signal = generateSignal(closes);
  const equity = broker.getEquity(price);
  const currentPosition = broker.getPosition();
  const qty = positionSize(equity, price, 0.01);

  console.log("------ BOT STEP ------");
  console.log("Price:", price.toFixed(2));
  console.log("Signal:", signal);
  console.log("Position:", currentPosition);
  console.log("Equity:", equity.toFixed(2));

  if (signal === "BUY" && currentPosition === 0 && qty > 0) {
    broker.placeOrder("BUY", qty, price);
  } else if (signal === "SELL" && currentPosition > 0) {
    broker.placeOrder("SELL", currentPosition, price);
  } else {
    console.log("No trade");
  }

  console.log("Account:", broker.getAccountState(price));
}

module.exports = { runBot };