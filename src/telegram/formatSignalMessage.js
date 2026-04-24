const { classifyRiskLevel } = require('../signals/assessRiskLevel');
const { escapeHtml, formatPrice, getPairStyling } = require('./pairStyling');

function formatSignalMessage(signal) {
  const style = getPairStyling(signal.symbol);
  const risk = classifyRiskLevel(signal);
  const direction = signal.direction || signal.side || 'N/A';
  const effectiveRisk = signal.riskLevel || risk.level;
  const effectiveScore = Number(signal.publicScore ?? signal.score);
  const rr = Number.isFinite(Number(risk.rewardRiskRatio))
    ? Number(risk.rewardRiskRatio).toFixed(2)
    : null;
  const lines = [
    `${style.emoji} <b>${escapeHtml(style.title)} ${escapeHtml(direction)}</b>`,
    '',
    `⚠️ <b>Risk:</b> ${escapeHtml(effectiveRisk)}`,
    `💰 <b>Entry:</b> ${escapeHtml(formatPrice(signal.entry))}`,
    `🛑 <b>Stop Loss:</b> ${escapeHtml(formatPrice(signal.stopLoss))}`,
  ];

  const takeProfits = Array.isArray(signal.takeProfits) ? signal.takeProfits.filter((value) => value != null) : [];

  takeProfits.forEach((takeProfit, index) => {
    lines.push(`🎯 <b>TP${index + 1}:</b> ${escapeHtml(formatPrice(takeProfit))}`);
  });

  if (rr) {
    lines.push(`📐 <b>RR:</b> 1:${escapeHtml(rr)}`);
  }

  if (signal.timeframe) {
    lines.push(`⏱️ <b>Timeframe:</b> ${escapeHtml(signal.timeframe)}`);
  }

  if (signal.strategyName) {
    lines.push(`🧭 <b>Strategy:</b> ${escapeHtml(signal.strategyName)}`);
  }

  if (Number.isFinite(effectiveScore)) {
    lines.push(`⭐ <b>Score:</b> ${escapeHtml(String(Math.round(effectiveScore)))}/100`);
  }

  if (signal.confidenceLabel) {
    lines.push(`🧠 <b>Confidence:</b> ${escapeHtml(signal.confidenceLabel)}`);
  }

  if (signal.sourceLabel) {
    lines.push(`🏷️ <b>Source:</b> ${escapeHtml(signal.sourceLabel)}`);
  }

  if (
    signal.learningAssessment &&
    Number.isFinite(Number(signal.learningAssessment.aggregateScore))
  ) {
    lines.push(`🧪 <b>Learned Score:</b> ${escapeHtml(String(signal.learningAssessment.aggregateScore))}`);
  }

  if (signal.reasoningSummary) {
    lines.push('');
    lines.push(`📝 <b>Why:</b> ${escapeHtml(signal.reasoningSummary)}`);
  }

  return lines.join('\n');
}

module.exports = {
  formatSignalMessage,
};
