const config = require("./config");
const { getHistoricalCloses } = require("./dataFeed");
const { generateSignal } = require("./strategy");
const { calculatePositionSize } = require("./risk");

const INITIAL_CASH = 10000;

function runBacktest() {
  const closes = getHistoricalCloses();
  let cash = INITIAL_CASH;
  let position = 0;
  let entryCost = null;
  let tradeCount = 0;
  let realizedPnl = 0;

  for (let i = 0; i < closes.length; i += 1) {
    const price = closes[i];
    const signal = generateSignal(closes.slice(0, i + 1));

    if (signal === "BUY" && position === 0) {
      const size = calculatePositionSize(cash, price);
      const cost = size * price + config.commissionPerTrade;

      if (size > 0 && cost <= cash) {
        cash -= cost;
        position = size;
        entryCost = cost;
        tradeCount += 1;
      }
    } else if (signal === "SELL" && position > 0) {
      const proceeds = position * price - config.commissionPerTrade;
      const pnl = entryCost === null ? 0 : proceeds - entryCost;

      cash += proceeds;
      position = 0;
      entryCost = null;
      tradeCount += 1;
      realizedPnl += pnl;
    }
  }

  const lastPrice = closes[closes.length - 1] ?? 0;
  const finalEquity = cash + position * lastPrice;

  console.log("Backtest complete");
  console.log(`Bars: ${closes.length}`);
  console.log(`Trades: ${tradeCount}`);
  console.log(`Realized PnL: ${realizedPnl.toFixed(2)}`);
  console.log(`Final equity: ${finalEquity.toFixed(2)}`);

  return {
    bars: closes.length,
    trades: tradeCount,
    realizedPnl,
    finalEquity,
  };
}

if (require.main === module) {
  runBacktest();
}

module.exports = { runBacktest };
