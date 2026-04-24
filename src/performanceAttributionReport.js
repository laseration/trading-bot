const { runBacktest } = require("./backtest");

function printBucket(label, buckets = {}) {
  console.log(label);
  Object.entries(buckets).forEach(([key, value]) => {
    console.log(
      `- ${key}: trades=${value.trades} pnl=${Number(value.pnl || 0).toFixed(2)} `
      + `wins=${value.wins} losses=${value.losses}`,
    );
  });
}

async function main() {
  const profile = {
    symbol: process.env.BACKTEST_SYMBOL || "EURUSD",
    dataSource: process.env.BACKTEST_SOURCE || "mock",
    signalSource: "strategy",
    broker: "paper",
  };
  const strategyName = process.env.BACKTEST_STRATEGY || "trend";
  const result = await runBacktest(profile, {
    strategyName,
    barCount: Number(process.env.BACKTEST_BAR_COUNT || 0) || undefined,
    printSummary: false,
  });

  console.log(`Performance attribution for ${result.symbol} (${result.strategyName})`);
  console.log(
    `Return=${result.metrics.totalReturnPct.toFixed(2)}% `
    + `Drawdown=${result.metrics.maxDrawdownPct.toFixed(2)}% `
    + `Sharpe=${result.metrics.sharpeRatio.toFixed(2)} `
    + `Trades=${result.metrics.tradeCount}`,
  );
  console.log("");
  printBucket("By direction", result.attribution.byDirection);
  console.log("");
  printBucket("By month", result.attribution.byMonth);
}

main().catch((err) => {
  console.error(`Performance attribution failed: ${err.message}`);
  process.exitCode = 1;
});
