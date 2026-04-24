const { log } = require('./logger');
const { aggregateWeeklyPerformance } = require('./signals/performanceAggregator');
const { formatWeeklySummary } = require('./telegram/formatWeeklySummary');
const { publishWeeklySummaryReport } = require('./telegram/publishingService');

function readArg(prefix) {
  const entry = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

async function main() {
  const days = Number(readArg('--days=') || 7);
  const explicitStart = readArg('--start=');
  const explicitEnd = readArg('--end=');
  const dryRun = process.argv.includes('--dry-run');
  const endAt = explicitEnd || new Date().toISOString();
  const startAt = explicitStart || new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const report = aggregateWeeklyPerformance({ startAt, endAt });

  if (dryRun) {
    console.log(formatWeeklySummary(report));
    return;
  }

  const result = await publishWeeklySummaryReport(report);
  log(result.posted ? '[WEEKLY_REPORT] Weekly report posted successfully' : '[WEEKLY_REPORT] Weekly report generated without posting');
  console.log(result.caption);
}

main().catch((err) => {
  log(`[WEEKLY_REPORT] Failed to generate weekly report: ${err.message}`);
  process.exit(1);
});
