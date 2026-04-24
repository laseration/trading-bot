const { calculateSignalResult } = require('../signals/performanceAggregator');
const { escapeHtml, formatPrice } = require('./pairStyling');

function getNetResult(signal) {
  const value = Number(calculateSignalResult(signal));
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function resolveOutcomeState(trackedSignal, updateEvent) {
  const actions = Array.isArray(updateEvent && updateEvent.actions) ? updateEvent.actions : [];
  const netResult = getNetResult(trackedSignal);

  if (actions.includes('sl_hit')) {
    return 'loss';
  }

  if (actions.includes('closed_profit')) {
    return 'win';
  }

  if (actions.includes('closed_loss')) {
    if (netResult === 0) {
      return 'breakeven';
    }

    return 'loss';
  }

  if (actions.includes('partial_close') || actions.includes('partial_tp_taken')) {
    return 'partial';
  }

  if (Number.isFinite(netResult) && netResult === 0) {
    return 'breakeven';
  }

  if (trackedSignal && trackedSignal.finalOutcome === 'win') {
    return 'win';
  }

  if (trackedSignal && trackedSignal.finalOutcome === 'loss') {
    return netResult === 0 ? 'breakeven' : 'loss';
  }

  return 'update';
}

function formatSignedPoints(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 'n/a';
  }

  if (numeric > 0) {
    return `+${numeric.toFixed(1)} points`;
  }

  if (numeric < 0) {
    return `${numeric.toFixed(1)} points`;
  }

  return '0.0 points';
}

function buildReference(trackedSignal) {
  const refs = [];

  if (trackedSignal && trackedSignal.id) {
    refs.push(`Signal #${trackedSignal.id}`);
  }

  if (trackedSignal && trackedSignal.postMessageId) {
    refs.push(`Msg ${trackedSignal.postMessageId}`);
  }

  if (trackedSignal && trackedSignal.execution && trackedSignal.execution.positionId) {
    refs.push(`Trade ${trackedSignal.execution.positionId}`);
  }

  return refs.join(' | ');
}

function inferReason(trackedSignal, updateEvent) {
  const actions = Array.isArray(updateEvent && updateEvent.actions) ? updateEvent.actions : [];
  const outcomeState = resolveOutcomeState(trackedSignal, updateEvent);

  if (outcomeState === 'loss') {
    if (actions.includes('sl_hit')) {
      return 'price reversed after entry and hit the stop loss';
    }

    if (Number(trackedSignal && trackedSignal.highestTpHit) >= 1) {
      return 'runner gave back gains after the first target';
    }

    return 'setup invalidated after entry';
  }

  if (outcomeState === 'win') {
    if (actions.includes('closed_profit') && Number(trackedSignal && trackedSignal.highestTpHit) >= 1) {
      return 'momentum continuation reached the profit target';
    }

    return 'price followed through in the trade direction';
  }

  if (outcomeState === 'breakeven') {
    return 'price moved in favor, then returned to the protected entry area';
  }

  if (outcomeState === 'partial') {
    return 'first target was secured while the remaining position stayed open';
  }

  if (actions.includes('trailing_started') || actions.includes('trail_stop_advanced')) {
    return 'the stop was tightened to protect open profit';
  }

  if (actions.includes('breakeven_moved')) {
    return 'risk was removed by moving the stop to breakeven';
  }

  return 'trade state updated';
}

function getOutcomeHeader(outcomeState) {
  if (outcomeState === 'win') {
    return '✅ TRADE CLOSED - TP HIT';
  }

  if (outcomeState === 'loss') {
    return '❌ TRADE CLOSED - LOSS';
  }

  if (outcomeState === 'breakeven') {
    return '🟡 TRADE CLOSED - BREAKEVEN';
  }

  if (outcomeState === 'partial') {
    return '🟦 TRADE UPDATE - PARTIAL TAKE PROFIT';
  }

  return 'ℹ️ TRADE UPDATE';
}

function formatTradeUpdateMessage(trackedSignal, updateEvent) {
  const outcomeState = resolveOutcomeState(trackedSignal, updateEvent);
  const netResult = getNetResult(trackedSignal);
  const entryPrice = trackedSignal && trackedSignal.execution && trackedSignal.execution.executionPrice != null
    ? trackedSignal.execution.executionPrice
    : trackedSignal.entry;
  const exitPrice = trackedSignal && trackedSignal.execution && trackedSignal.execution.exitPrice != null
    ? trackedSignal.execution.exitPrice
    : updateEvent && updateEvent.reconciliation && updateEvent.reconciliation.exitPrice;
  const direction = trackedSignal.direction || trackedSignal.side || 'N/A';
  const ref = buildReference(trackedSignal);
  const reason = inferReason(trackedSignal, updateEvent);
  const lines = [
    `<b>${escapeHtml(getOutcomeHeader(outcomeState))}</b>`,
    '',
    `<b>Pair:</b> ${escapeHtml(trackedSignal.symbol || updateEvent.symbol || 'N/A')}`,
    `<b>Direction:</b> ${escapeHtml(direction)}`,
    `<b>Entry:</b> ${escapeHtml(formatPrice(entryPrice))}`,
  ];

  if (outcomeState === 'loss') {
    lines.push(`<b>Stop Loss Hit:</b> ${escapeHtml(formatPrice(exitPrice ?? trackedSignal.stopLoss))}`);
  } else if (outcomeState === 'win') {
    lines.push(`<b>Take Profit Hit:</b> ${escapeHtml(formatPrice(exitPrice ?? (trackedSignal.execution && trackedSignal.execution.takeProfit)))}`);
  } else if (outcomeState === 'breakeven') {
    lines.push(`<b>Exit:</b> ${escapeHtml(formatPrice(exitPrice ?? entryPrice))}`);
  } else if (outcomeState === 'partial') {
    lines.push(`<b>Partial Exit:</b> ${escapeHtml(formatPrice(exitPrice ?? (trackedSignal.execution && trackedSignal.execution.takeProfit)))}`);
  }

  if (Number.isFinite(netResult)) {
    lines.push('');
    lines.push(`<b>Result:</b> ${escapeHtml(formatSignedPoints(netResult))}`);
  }

  if (ref) {
    lines.push('');
    lines.push(`<b>Ref:</b> ${escapeHtml(ref)}`);
  }

  lines.push('');
  lines.push(`<b>Reason:</b> ${escapeHtml(reason)}`);

  return lines.join('\n');
}

module.exports = {
  buildReference,
  formatSignedPoints,
  formatTradeUpdateMessage,
  getNetResult,
  inferReason,
  resolveOutcomeState,
};
