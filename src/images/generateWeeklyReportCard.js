const { log } = require('../logger');
const { renderCardImage } = require('./renderCard');

async function generateWeeklyReportCard(report) {
  const { summary, sourceSummary } = report;
  const rows = [
    { label: 'Signals', value: String(summary.totalSignals) },
    { label: 'Wins', value: String(summary.wins) },
    { label: 'Losses', value: String(summary.losses) },
    { label: 'Win Rate', value: `${summary.winRate}%` },
    { label: 'Net Result', value: `${summary.netPoints > 0 ? '+' : ''}${summary.netPoints} points` },
    { label: 'TP1 Hits', value: String(summary.tp1Hits) },
    { label: 'TP2 Hits', value: String(summary.tp2Hits) },
    { label: 'TP3 Hits', value: String(summary.tp3Hits) },
  ];

  if (summary.bestPair && summary.bestPair.symbol) {
    rows.push({ label: 'Best Pair', value: `${summary.bestPair.symbol} (${summary.bestPair.winRate}%)` });
  }

  if (sourceSummary && sourceSummary.bestSource && sourceSummary.bestSource.source) {
    rows.push({ label: 'Best Source', value: `${sourceSummary.bestSource.source} (${sourceSummary.bestSource.winRate}%)` });
  }

  const chartPoints = [
    { label: 'Signals', value: Math.max(summary.totalSignals, 0), color: '#8ea6c3' },
    { label: 'Wins', value: Math.max(summary.wins, 0), color: '#62d26f' },
    { label: 'Losses', value: Math.max(summary.losses, 0), color: '#ff6b6b' },
    { label: 'TP1', value: Math.max(summary.tp1Hits, 0), color: '#ffd166' },
    { label: 'TP2', value: Math.max(summary.tp2Hits, 0), color: '#7f8cff' },
    { label: 'TP3', value: Math.max(summary.tp3Hits, 0), color: '#4ecdc4' },
  ];

  const card = await renderCardImage({
    prefix: 'weekly-report',
    eyebrow: 'Performance Summary',
    title: 'WEEKLY REPORT',
    subtitle: `${report.startAt.slice(0, 10)} to ${report.endAt.slice(0, 10)}`,
    accentColor: '#62d26f',
    badge: 'WEEKLY',
    rows,
    footer: 'Summary generated from tracked signal outcomes.',
    chart: {
      points: chartPoints,
      lineColor: '#62d26f',
    },
  });

  log(`[IMAGES] Weekly report card generated: ${card.filePath}`);
  return card;
}

module.exports = {
  generateWeeklyReportCard,
};
