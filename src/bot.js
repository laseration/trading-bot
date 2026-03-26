const { log, logTrade, logEquity } = require('./logger');
const { getLatestPrice } = require('./dataFeed');
const { generateSignal } = require('./strategy');
const { calculatePositionSize } = require('./risk');
const broker = require('./broker');

let prices = [];

function runBot() {
  const price = getLatestPrice();
  prices.push(price);

  if (prices.length > 100) {
    prices.shift();
  }

  const signal = generateSignal(prices);

  log("------ BOT STEP ------");
  log(`Price: ${price}`);
  log(`Signal: ${signal}`);

  const account = broker.getAccountState(price);

  if (signal === "BUY" && account.position === 0) {
    const size = calculatePositionSize(account.cash, price);

    if (size > 0) {
      broker.placeOrder("BUY", size, price);
      log(`BUY executed: size=${size} price=${price}`);
      const tradeAccount = broker.getAccountState(price);
      logTrade({
        timestamp: new Date().toISOString(),
        side: "BUY",
        qty: size,
        price,
        cash: tradeAccount.cash,
        position: tradeAccount.position,
        equity: tradeAccount.equity,
      });
    } else {
      log("BUY skipped: position size was 0");
    }
  } else if (signal === "SELL" && account.position > 0) {
    broker.placeOrder("SELL", account.position, price);
    log(`SELL executed: size=${account.position} price=${price}`);
    const tradeAccount = broker.getAccountState(price);
    logTrade({
      timestamp: new Date().toISOString(),
      side: "SELL",
      qty: account.position,
      price,
      cash: tradeAccount.cash,
      position: tradeAccount.position,
      equity: tradeAccount.equity,
    });
  } else {
    log("No trade");
  }

  const updatedAccount = broker.getAccountState(price);
  log(`Cash: ${updatedAccount.cash}`);
  log(`Position: ${updatedAccount.position}`);
  log(`Equity: ${updatedAccount.equity}`);
  logEquity({
  timestamp: new Date().toISOString(),
  cash: updatedAccount.cash,
  position: updatedAccount.position,
  equity: updatedAccount.equity,
});
}

module.exports = { runBot };
