const config = require("../config");
const { buildBacktestAudit } = require("./backtestAudit");

function main() {
  const audit = buildBacktestAudit(config);

  console.log("Backtest Realism Audit");
  console.log("======================");
  console.log(`symbol: ${audit.profile.symbol}`);
  console.log(`source: ${audit.profile.source}`);
  console.log(`broker: ${audit.profile.broker}`);
  console.log(`strategy: ${audit.strategyName}`);
  console.log(`timeframe: ${audit.timeframe}`);
  console.log(`bar count: ${audit.barCount}`);
  console.log(`walk-forward window/step bars: ${audit.walkForwardWindowBars}/${audit.walkForwardStepBars}`);
  console.log("");
  console.log("Warnings");
  console.log("--------");

  audit.warnings.forEach((warning) => {
    console.log(`- ${warning.code}: ${warning.message}`);
  });

  console.log("");
  console.log("This audit is informational only; it does not run or alter backtest results.");
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
