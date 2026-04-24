const { log } = require('../logger');
const { formatPrice, getPairStyling } = require('../telegram/pairStyling');
const {
  buildReference,
  formatSignedPoints,
  getNetResult,
  inferReason,
  resolveOutcomeState,
} = require('../telegram/formatTradeUpdateMessage');
const { renderCardImage } = require('./renderCard');

function getOutcomeVisual(outcomeState) {
  if (outcomeState === 'win') {
    return {
      accentColor: '#43d17a',
      eyebrow: 'Trade Closed',
      badge: 'TP HIT',
      titleSuffix: 'WIN',
      outcomeLabel: 'TP HIT',
      outcomeColor: '#43d17a',
    };
  }

  if (outcomeState === 'loss') {
    return {
      accentColor: '#ff6b6b',
      eyebrow: 'Trade Closed',
      badge: 'SL HIT',
      titleSuffix: 'LOSS',
      outcomeLabel: 'SL HIT',
      outcomeColor: '#ff6b6b',
    };
  }

  if (outcomeState === 'breakeven') {
    return {
      accentColor: '#ffd166',
      eyebrow: 'Trade Closed',
      badge: 'BREAKEVEN',
      titleSuffix: 'BREAKEVEN',
      outcomeLabel: 'BREAKEVEN',
      outcomeColor: '#ffd166',
    };
  }

  if (outcomeState === 'partial') {
    return {
      accentColor: '#5aa9ff',
      eyebrow: 'Trade Update',
      badge: 'PARTIAL TP',
      titleSuffix: 'PARTIAL',
      outcomeLabel: 'PARTIAL TP',
      outcomeColor: '#5aa9ff',
    };
  }

  return {
    accentColor: '#8ea6c3',
    eyebrow: 'Trade Update',
    badge: 'UPDATE',
    titleSuffix: 'UPDATE',
    outcomeLabel: 'UPDATE',
    outcomeColor: '#8ea6c3',
  };
}

async function generateResultCard(signal, updateEvent) {
  const style = getPairStyling(signal.symbol);
  const outcomeState = resolveOutcomeState(signal, updateEvent);
  const visual = getOutcomeVisual(outcomeState);
  const entryPrice = signal.execution && signal.execution.executionPrice != null
    ? signal.execution.executionPrice
    : signal.entry;
  const exitPrice = signal.execution && signal.execution.exitPrice != null
    ? signal.execution.exitPrice
    : updateEvent && updateEvent.reconciliation && updateEvent.reconciliation.exitPrice;
  const netResult = getNetResult(signal);
  const ref = buildReference(signal);
  const reason = inferReason(signal, updateEvent);
  const rows = [
    { label: 'Pair', value: signal.symbol || updateEvent.symbol || 'N/A' },
    { label: 'Direction', value: signal.direction || 'N/A' },
    { label: 'Entry', value: formatPrice(entryPrice) },
  ];

  if (outcomeState === 'loss') {
    rows.push({ label: 'Stop Loss Hit', value: formatPrice(exitPrice ?? signal.stopLoss) });
  } else if (outcomeState === 'win') {
    rows.push({ label: 'Take Profit Hit', value: formatPrice(exitPrice ?? (signal.execution && signal.execution.takeProfit)) });
  } else if (outcomeState === 'breakeven') {
    rows.push({ label: 'Exit', value: formatPrice(exitPrice ?? entryPrice) });
  } else if (outcomeState === 'partial') {
    rows.push({ label: 'Partial Exit', value: formatPrice(exitPrice ?? (signal.execution && signal.execution.takeProfit)) });
  }

  if (Number.isFinite(netResult)) {
    rows.push({ label: 'Result', value: formatSignedPoints(netResult) });
  }

  if (ref) {
    rows.push({ label: 'Ref', value: ref });
  }

  rows.push({ label: 'Reason', value: reason });

  const chartPoints = [];
  if (signal.stopLoss != null) {
    chartPoints.push({
      label: outcomeState === 'loss' ? 'SL HIT' : 'SL',
      value: signal.stopLoss,
      color: outcomeState === 'loss' ? '#ff6b6b' : '#8f4b57',
    });
  }

  if (signal.entry != null || entryPrice != null) {
    chartPoints.push({
      label: outcomeState === 'breakeven' ? 'BE' : 'ENTRY',
      value: entryPrice ?? signal.entry,
      color: '#ffd166',
    });
  }

  (signal.takeProfits || []).slice(0, 3).forEach((takeProfit, index) => {
    chartPoints.push({
      label: outcomeState === 'win' && index === Math.max(0, Number(signal.highestTpHit || 1) - 1) ? 'TP HIT' : `TP${index + 1}`,
      value: takeProfit,
      color: outcomeState === 'win' ? '#43d17a' : '#62d26f',
    });
  });

  const card = await renderCardImage({
    prefix: 'result',
    eyebrow: visual.eyebrow,
    title: `${signal.symbol || 'SIGNAL'} ${visual.titleSuffix}`,
    subtitle: ref || 'Tracked result update',
    accentColor: visual.accentColor,
    badge: visual.badge,
    rows,
    footer: `Reason: ${reason}.`,
    chart: {
      points: chartPoints,
      lineColor: visual.accentColor,
      outcomeLabel: visual.outcomeLabel,
      outcomeColor: visual.outcomeColor,
    },
  });

  log(`[IMAGES] Result card generated: ${card.filePath}`);
  return card;
}

module.exports = {
  generateResultCard,
};
