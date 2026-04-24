const { compareStrategies } = require("./backtest");

async function main() {
  const profile = {
    symbol: process.env.BACKTEST_SYMBOL || "EURUSD",
    dataSource: process.env.BACKTEST_SOURCE || "mock",
    signalSource: "strategy",
    broker: "paper",
  };
  const strategyNames = String(process.env.BACKTEST_STRATEGIES || "trend,breakout,mean_reversion")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const result = await compareStrategies(profile, strategyNames, {
    barCount: Number(process.env.BACKTEST_BAR_COUNT || 0) || undefined,
  });

  console.log(`Strategy comparison for ${result.symbol}`);

  result.ranked.forEach((entry, index) => {
    console.log(
      `${index + 1}. ${entry.strategyName} | return=${entry.metrics.totalReturnPct.toFixed(2)}% `
      + `| dd=${entry.metrics.maxDrawdownPct.toFixed(2)}% | sharpe=${entry.metrics.sharpeRatio.toFixed(2)} `
      + `| trades=${entry.metrics.tradeCount} | winRate=${entry.metrics.winRate.toFixed(1)}%`,
    );
  });

  if (result.winner) {
    console.log("");
    console.log(`Winner: ${result.winner.strategyName}`);
  }
}

main().catch((err) => {
  console.error(`Strategy comparison failed: ${err.message}`);
  process.exitCode = 1;
});
