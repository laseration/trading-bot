const config = require('./config');
const { publishSignal } = require('./telegram/publishingService');
const { runNewsBacktest } = require('./newsAnalyzer');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    filePath: config.news.backtestFile,
    publish: false,
  };

  for (const arg of argv) {
    if (arg === '--publish') {
      args.publish = true;
      continue;
    }

    if (arg.startsWith('--file=')) {
      args.filePath = arg.slice('--file='.length);
    }
  }

  return args;
}

async function main() {
  const options = parseArgs();
  const result = await runNewsBacktest({ filePath: options.filePath });

  console.log(`Loaded ${result.articleCount} historical article(s)`);
  console.log(`Generated ${result.summary.totalSignals} signal(s)`);
  console.log(`By symbol: ${JSON.stringify(result.summary.bySymbol)}`);
  console.log(`By side: ${JSON.stringify(result.summary.bySide)}`);

  for (const signal of result.signals) {
    console.log(
      `${signal.symbol} ${signal.direction} | ${signal.confidenceLabel} | ${signal.sourceLabel} | risk=${signal.riskLevel}`,
    );
  }

  if (options.publish) {
    for (const signal of result.signals) {
      await publishSignal(signal, { executed: false });
    }

    console.log(`Published ${result.signals.length} news backtest signal(s) to Telegram`);
  }
}

main().catch((err) => {
  console.error(`News backtest failed: ${err.message}`);
  process.exit(1);
});
