const config = require("./config");
const { runWalkForward } = require("./backtest");

async function main() {
  const profile = {
    symbol: process.env.BACKTEST_SYMBOL || "EURUSD",
    dataSource: process.env.BACKTEST_SOURCE || "mock",
    signalSource: "strategy",
    broker: "paper",
  };
  const strategyName = process.env.BACKTEST_STRATEGY || config.strategy.name;
  const result = await runWalkForward(profile, {
    strategyName,
  });

  console.log(`Walk-forward analysis for ${result.symbol} (${result.strategyName})`);
  console.log(`Timeframe: ${result.timeframe}`);
  console.log(`Windows: ${result.totalWindows}`);
  console.log(`Signals: ${JSON.stringify(result.signalCounts)}`);
  console.log("");

  result.windows.slice(-10).forEach((window, index) => {
    console.log(
      `${index + 1}. ${window.startTime} -> ${window.endTime} | signal=${window.signal} `
      + `| reasons=${(window.reasons || []).join(",") || "none"}`
      + `${window.confidenceLabel ? ` | confidence=${window.confidenceLabel}` : ""}`,
    );
  });
}

main().catch((err) => {
  console.error(`Walk-forward analysis failed: ${err.message}`);
  process.exitCode = 1;
});
