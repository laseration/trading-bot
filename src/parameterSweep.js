const { runBacktest } = require("./backtest");

function envList(name, defaultValues) {
  const raw = process.env[name];

  if (!raw) {
    return defaultValues;
  }

  return String(raw)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

async function main() {
  const profile = {
    symbol: process.env.BACKTEST_SYMBOL || "EURUSD",
    dataSource: process.env.BACKTEST_SOURCE || "mock",
    signalSource: "strategy",
    broker: "paper",
  };
  const strategyName = process.env.BACKTEST_STRATEGY || "trend";
  const shortMas = envList("SWEEP_SHORT_MAS", [10, 20, 30]);
  const longMas = envList("SWEEP_LONG_MAS", [40, 50, 80]);
  const adxMins = envList("SWEEP_ADX_MINS", [18, 25, 30]);
  const atrStops = envList("SWEEP_ATR_STOPS", [1.5, 1.8, 2.2]);
  const results = [];

  for (const shortMa of shortMas) {
    for (const longMa of longMas) {
      if (shortMa >= longMa) {
        continue;
      }

      for (const adxMin of adxMins) {
        for (const atrStopMultiplier of atrStops) {
          const result = await runBacktest(profile, {
            printSummary: false,
            strategyName,
            barCount: Number(process.env.BACKTEST_BAR_COUNT || 0) || undefined,
            strategyOverrides: {
              shortMa,
              longMa,
              adxMin,
              atrStopMultiplier,
            },
          });

          results.push({
            shortMa,
            longMa,
            adxMin,
            atrStopMultiplier,
            returnPct: result.metrics.totalReturnPct,
            maxDrawdownPct: result.metrics.maxDrawdownPct,
            sharpeRatio: result.metrics.sharpeRatio,
            tradeCount: result.metrics.tradeCount,
            winRate: result.metrics.winRate,
          });
        }
      }
    }
  }

  const ranked = results.sort((left, right) => {
    if (right.returnPct !== left.returnPct) {
      return right.returnPct - left.returnPct;
    }

    if (left.maxDrawdownPct !== right.maxDrawdownPct) {
      return left.maxDrawdownPct - right.maxDrawdownPct;
    }

    return right.sharpeRatio - left.sharpeRatio;
  });

  console.log(`Parameter sweep for ${profile.symbol} (${strategyName})`);
  ranked.slice(0, 10).forEach((entry, index) => {
    console.log(
      `${index + 1}. short=${entry.shortMa} long=${entry.longMa} adx=${entry.adxMin} atrStop=${entry.atrStopMultiplier} `
      + `| return=${entry.returnPct.toFixed(2)}% dd=${entry.maxDrawdownPct.toFixed(2)}% `
      + `| sharpe=${entry.sharpeRatio.toFixed(2)} trades=${entry.tradeCount} winRate=${entry.winRate.toFixed(1)}%`,
    );
  });
}

main().catch((err) => {
  console.error(`Parameter sweep failed: ${err.message}`);
  process.exitCode = 1;
});
