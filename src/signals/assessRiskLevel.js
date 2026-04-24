const { getPipSize } = require('./performanceAggregator');

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSymbolStopBand(symbol) {
  const normalized = String(symbol || '').toUpperCase();

  if (normalized === 'XAUUSD') {
    return { min: 25, max: 350, softMax: 220 };
  }

  return { min: 10, max: 90, softMax: 60 };
}

function classifyRiskLevel(signal = {}) {
  const entry = toNumber(signal.entry);
  const stopLoss = toNumber(signal.stopLoss);
  const takeProfits = Array.isArray(signal.takeProfits)
    ? signal.takeProfits.map(toNumber).filter((value) => value != null)
    : [];

  if (entry == null || stopLoss == null) {
    return {
      level: 'High',
      score: 35,
      stopDistance: null,
      rewardRiskRatio: null,
      reasons: ['missing_entry_or_stop'],
    };
  }

  const pipSize = getPipSize(signal.symbol);
  const stopDistance = Math.abs(entry - stopLoss) / pipSize;
  const primaryTakeProfit = takeProfits[0] ?? null;
  const finalTakeProfit = takeProfits.length > 0 ? takeProfits[takeProfits.length - 1] : null;
  const rewardDistance = primaryTakeProfit == null ? null : Math.abs(primaryTakeProfit - entry) / pipSize;
  const finalRewardDistance = finalTakeProfit == null ? null : Math.abs(finalTakeProfit - entry) / pipSize;
  const rrToTp1 = rewardDistance != null && stopDistance > 0
    ? rewardDistance / stopDistance
    : null;
  const rrToFinal = finalRewardDistance != null && stopDistance > 0
    ? finalRewardDistance / stopDistance
    : null;
  const stopBand = getSymbolStopBand(signal.symbol);

  let score = 50;
  const reasons = [];

  if (stopDistance >= stopBand.min && stopDistance <= stopBand.softMax) {
    score += 12;
    reasons.push('balanced_stop_distance');
  } else if (stopDistance > stopBand.softMax && stopDistance <= stopBand.max) {
    score += 4;
    reasons.push('wide_but_acceptable_stop');
  } else if (stopDistance > stopBand.max) {
    score -= 14;
    reasons.push('very_wide_stop');
  } else if (stopDistance < stopBand.min) {
    score -= 15;
    reasons.push('stop_too_tight');
  } else {
    score -= 6;
    reasons.push('tight_stop');
  }

  if (rrToTp1 != null) {
    if (rrToTp1 >= 1.6) {
      score += 18;
      reasons.push('strong_tp1_rr');
    } else if (rrToTp1 >= 1.3) {
      score += 10;
      reasons.push('good_tp1_rr');
    } else if (rrToTp1 >= 1) {
      score += 2;
      reasons.push('acceptable_tp1_rr');
    } else {
      score -= 18;
      reasons.push('poor_tp1_rr');
    }
  }

  if (rrToFinal != null) {
    if (rrToFinal >= 2) {
      score += 25;
      reasons.push('strong_final_rr');
    } else if (rrToFinal >= 1.6) {
      score += 15;
      reasons.push('good_final_rr');
    } else if (rrToFinal >= 1.3) {
      score += 6;
      reasons.push('acceptable_final_rr');
    } else if (rrToFinal >= 1) {
      score -= 8;
      reasons.push('weak_final_rr');
    } else {
      score -= 22;
      reasons.push('poor_final_rr');
    }
  }

  if (takeProfits.length >= 3) {
    score += 3;
    reasons.push('layered_profit_targets');
  }

  let level = 'High';

  if (score >= 78) {
    level = 'Low';
  } else if (score >= 60) {
    level = 'Medium';
  }

  return {
    level,
    score,
    stopDistance: Number.isFinite(stopDistance) ? Number(stopDistance.toFixed(1)) : null,
    rewardRiskRatio: Number.isFinite(rrToTp1) ? Number(rrToTp1.toFixed(2)) : null,
    rrToTp1: Number.isFinite(rrToTp1) ? Number(rrToTp1.toFixed(2)) : null,
    rrToFinal: Number.isFinite(rrToFinal) ? Number(rrToFinal.toFixed(2)) : null,
    reasons,
  };
}

module.exports = {
  classifyRiskLevel,
};
