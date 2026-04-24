const { escapeHtml, formatPercent } = require('./pairStyling');

function formatSignedPoints(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 'n/a';
  }

  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(1)} points`;
}

function formatTradeLine(trade) {
  const outcome = String(trade.outcome || '').toLowerCase();
  const prefix = outcome === 'win'
    ? 'WIN'
    : outcome === 'loss'
      ? 'LOSS'
      : outcome === 'cancelled'
        ? 'CANCELLED'
        : String(trade.status || 'closed').toUpperCase();

  return `${escapeHtml(trade.symbol)} ${escapeHtml(trade.direction || '')} | `
    + `<b>${escapeHtml(prefix)}</b> | `
    + `${escapeHtml(formatSignedPoints(trade.netPoints))}`;
}

function formatDailySummary(report) {
  const summary = report && report.summary ? report.summary : {};
  const lines = [
    '<b>📊 DAILY SUMMARY</b>',
    '',
    `Trades: <b>${escapeHtml(String(summary.settledSignals || 0))}</b>`,
    `Wins: <b>${escapeHtml(String(summary.wins || 0))}</b>`,
    `Losses: <b>${escapeHtml(String(summary.losses || 0))}</b>`,
    `Win Rate: <b>${escapeHtml(formatPercent(summary.winRate || 0))}</b>`,
    `Net Result: <b>${escapeHtml(formatSignedPoints(summary.netPoints || 0))}</b>`,
  ];

  return lines.join('\n');
}

function formatWeeklySummary(report) {
  const { summary, sourceSummary, startAt, endAt, tradeDetails } = report;
  const lines = [
    '<b>WEEKLY REPORT</b>',
    '',
    `Signals: <b>${escapeHtml(String(summary.totalSignals))}</b>`,
    `Wins: <b>${escapeHtml(String(summary.wins))}</b>`,
    `Losses: <b>${escapeHtml(String(summary.losses))}</b>`,
    `Win Rate: <b>${escapeHtml(formatPercent(summary.winRate))}</b>`,
    `Net Result: <b>${escapeHtml(formatSignedPoints(summary.netPoints))}</b>`,
    `TP1 Hits: <b>${escapeHtml(String(summary.tp1Hits))}</b>`,
    `TP2 Hits: <b>${escapeHtml(String(summary.tp2Hits))}</b>`,
    `TP3 Hits: <b>${escapeHtml(String(summary.tp3Hits))}</b>`,
  ];

  if (summary.bestPair && summary.bestPair.symbol) {
    lines.push(`Best Pair: <b>${escapeHtml(summary.bestPair.symbol)}</b> (${escapeHtml(formatPercent(summary.bestPair.winRate))})`);
  }

  if (sourceSummary && sourceSummary.bestSource && sourceSummary.bestSource.source) {
    lines.push(
      `Best Source: <b>${escapeHtml(sourceSummary.bestSource.source)}</b> `
      + `(${escapeHtml(formatPercent(sourceSummary.bestSource.winRate))}, ${escapeHtml(String(sourceSummary.bestSource.settledSignals))} settled)`,
    );
  }

  if (sourceSummary && Array.isArray(sourceSummary.sources) && sourceSummary.sources.length > 1) {
    lines.push('');
    lines.push('<b>Source Scoreboard</b>');

    for (const source of sourceSummary.sources.slice(0, 3)) {
      lines.push(
        `${escapeHtml(source.source)}: `
        + `${escapeHtml(formatPercent(source.winRate))} win rate, `
        + `${escapeHtml(formatSignedPoints(source.netPoints))}, `
        + `${escapeHtml(String(source.settledSignals))} settled`,
      );
    }
  }

  if (Array.isArray(tradeDetails) && tradeDetails.length > 0) {
    lines.push('');
    lines.push('<b>Trades</b>');

    for (const trade of tradeDetails) {
      lines.push(formatTradeLine(trade));
    }
  }

  lines.push('');
  lines.push(`Window: <b>${escapeHtml(startAt)} to ${escapeHtml(endAt)}</b>`);
  return lines.join('\n');
}

module.exports = {
  formatDailySummary,
  formatTradeLine,
  formatWeeklySummary,
  formatSignedPoints,
};
