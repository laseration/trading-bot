const { log } = require('../logger');
const { classifyRiskLevel } = require('../signals/assessRiskLevel');
const { formatPrice, getPairStyling } = require('../telegram/pairStyling');
const { renderCardImage } = require('./renderCard');

async function generateSignalCard(signal) {
  const style = getPairStyling(signal.symbol);
  const risk = classifyRiskLevel(signal);
  const rows = [
    { label: 'Pair', value: signal.symbol || 'N/A' },
    { label: 'Direction', value: signal.direction || signal.side || 'N/A' },
    { label: 'Entry', value: formatPrice(signal.entry) },
    { label: 'Stop Loss', value: formatPrice(signal.stopLoss) },
  ];

  (signal.takeProfits || []).slice(0, 3).forEach((takeProfit, index) => {
    rows.push({ label: `TP${index + 1}`, value: formatPrice(takeProfit) });
  });

  if (signal.timeframe) {
    rows.push({ label: 'Timeframe', value: signal.timeframe });
  }

  rows.push({ label: 'Risk Level', value: risk.level });

  const chartPoints = [];

  if (signal.stopLoss != null) {
    chartPoints.push({ label: 'SL', value: signal.stopLoss, color: '#ff6b6b' });
  }

  if (signal.entry != null) {
    chartPoints.push({ label: 'Entry', value: signal.entry, color: '#ffd166' });
  }

  (signal.takeProfits || []).slice(0, 3).forEach((takeProfit, index) => {
    chartPoints.push({ label: `TP${index + 1}`, value: takeProfit, color: '#62d26f' });
  });

  const card = await renderCardImage({
    prefix: 'signal',
    eyebrow: 'Premium Signal',
    title: style.title,
    subtitle: signal.sourceLabel || 'Validated setup ready for execution',
    accentColor: style.accentColor,
    badge: signal.direction || signal.side || 'SIGNAL',
    rows,
    footer: `Signal profile risk level: ${risk.level}.`,
    chart: {
      points: chartPoints,
      lineColor: style.accentColor,
    },
  });

  log(`[IMAGES] Signal card generated: ${card.filePath}`);
  return card;
}

module.exports = {
  generateSignalCard,
};
