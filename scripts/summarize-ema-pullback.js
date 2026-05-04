const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const runtimeDir = path.join(repoRoot, 'runtime');
const NEAR_ADX_MIN = 10;
const MAX_STRUCTURAL_PULLBACK_DISTANCE_ATR = 1.5;

function findLatestRuntimeLog() {
  if (!fs.existsSync(runtimeDir)) {
    return null;
  }

  const candidates = fs.readdirSync(runtimeDir)
    .filter((name) => /^codex-demo-bot-.*\.out\.log$/i.test(name))
    .map((name) => {
      const filePath = path.join(runtimeDir, name);
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates.length > 0 ? candidates[0].filePath : null;
}

function parseValue(value) {
  if (value == null || value === '' || value === 'na' || value === 'none') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function parseDiagnosticLine(line) {
  if (!line.includes('[EMA_PULLBACK]')) {
    return null;
  }

  const match = line.match(/\[EMA_PULLBACK\]\s+([A-Z0-9.-]+)/);
  if (!match) {
    return null;
  }

  const record = {
    symbol: match[1],
    raw: line,
  };

  for (const pair of line.matchAll(/(\w+)=([^\s]+)/g)) {
    record[pair[1]] = parseValue(pair[2]);
  }

  record.reasonsList = typeof record.reasons === 'string' && record.reasons !== 'none'
    ? record.reasons.split('|').filter(Boolean)
    : [];
  record.blocksList = typeof record.blocks === 'string' && record.blocks !== 'none'
    ? record.blocks.split('|').filter(Boolean)
    : [];

  return record;
}

function increment(map, key) {
  const normalizedKey = key == null || key === '' ? 'UNKNOWN' : String(key);
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + 1);
}

function summarizeNumeric(records, field) {
  const values = records
    .map((record) => Number(record[field]))
    .filter(Number.isFinite);

  if (values.length === 0) {
    return null;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    avg: total / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function formatMap(map) {
  const rows = [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  return rows.length > 0
    ? rows.map(([key, count]) => `  ${key}: ${count}`).join('\n')
    : '  none';
}

function isAllowedSession(session) {
  const normalized = String(session || '').toUpperCase();
  return normalized.includes('LONDON') || normalized.includes('NEWYORK');
}

function isAcceptableRiskReward(record) {
  const rrTp1 = Number(record.rrTp1);
  const rrFinal = Number(record.rrFinal);
  return Number.isFinite(rrTp1) && rrTp1 >= 1
    && Number.isFinite(rrFinal) && rrFinal >= 1.4;
}

function hasAcceptablePullbackDistance(record) {
  const pullbackDistanceAtr = Number(record.pullbackDistanceAtr);
  return Number.isFinite(pullbackDistanceAtr)
    && pullbackDistanceAtr <= MAX_STRUCTURAL_PULLBACK_DISTANCE_ATR;
}

function isStructurallyValid(record) {
  return String(record.trendAligned).toLowerCase() === 'true'
    && isAcceptableRiskReward(record)
    && isAllowedSession(record.session)
    && hasAcceptablePullbackDistance(record);
}

function isExecutionClose(record) {
  const reasons = record.reasonsList || [];
  const adx = Number(record.adx);
  const failedContinuation = reasons.includes('continuation_not_confirmed');
  const failedTrigger = reasons.includes('trigger_candle_too_small');

  return String(record.decision || '').toUpperCase() === 'HOLD'
    && isStructurallyValid(record)
    && Number.isFinite(adx)
    && adx >= NEAR_ADX_MIN
    && !(failedContinuation && failedTrigger);
}

function isWeakMarketStructural(record) {
  const adx = Number(record.adx);
  const regime = String(record.regime || '').toUpperCase();

  return isStructurallyValid(record)
    && !isExecutionClose(record)
    && ((Number.isFinite(adx) && adx < NEAR_ADX_MIN) || regime === 'RANGING');
}

function main() {
  const inputPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : findLatestRuntimeLog();

  if (!inputPath) {
    console.error('No runtime/codex-demo-bot-*.out.log file found');
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Log file not found: ${inputPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/);
  const records = lines.map(parseDiagnosticLine).filter(Boolean);
  const bySymbol = new Map();
  const byDecisionSignal = new Map();
  const holdReasons = new Map();
  const bySession = new Map();
  const byRegime = new Map();

  for (const record of records) {
    increment(bySymbol, record.symbol);
    increment(byDecisionSignal, `${record.decision || 'UNKNOWN'}/${record.signal || 'UNKNOWN'}`);
    increment(bySession, record.session);
    increment(byRegime, record.regime);

    if (String(record.decision || '').toUpperCase() === 'HOLD') {
      for (const reason of record.reasonsList) {
        increment(holdReasons, reason);
      }
    }
  }

  const adx = summarizeNumeric(records, 'adx');
  const pullback = summarizeNumeric(records, 'pullbackDistanceAtr');
  const structurallyValidRecords = records.filter(isStructurallyValid);
  const executionCloseRecords = records.filter(isExecutionClose);
  const weakMarketStructuralRecords = records.filter(isWeakMarketStructural);

  console.log(`EMA Pullback Diagnostics Summary`);
  console.log(`Log file: ${inputPath}`);
  console.log(`Total EMA_PULLBACK diagnostics found: ${records.length}`);
  console.log('');
  console.log('Count by symbol:');
  console.log(formatMap(bySymbol));
  console.log('');
  console.log('Count by decision/signal:');
  console.log(formatMap(byDecisionSignal));
  console.log('');
  console.log('Most common HOLD reasons:');
  console.log(formatMap(holdReasons));
  console.log('');
  console.log(`ADX: count=${adx ? adx.count : 0} avg=${adx ? formatNumber(adx.avg, 2) : 'n/a'} min=${adx ? formatNumber(adx.min, 2) : 'n/a'} max=${adx ? formatNumber(adx.max, 2) : 'n/a'}`);
  console.log(`Pullback distance ATR: count=${pullback ? pullback.count : 0} avg=${pullback ? formatNumber(pullback.avg, 2) : 'n/a'} min=${pullback ? formatNumber(pullback.min, 2) : 'n/a'} max=${pullback ? formatNumber(pullback.max, 2) : 'n/a'}`);
  console.log('');
  console.log('Count by session:');
  console.log(formatMap(bySession));
  console.log('');
  console.log('Count by regime:');
  console.log(formatMap(byRegime));
  console.log('');
  console.log(`Structurally valid setups: ${structurallyValidRecords.length}`);
  console.log(`Execution-close setups: ${executionCloseRecords.length}`);
  console.log(`Weak-market structural setups: ${weakMarketStructuralRecords.length}`);

  if (executionCloseRecords.length > 0) {
    console.log('Execution-close details:');
    for (const record of executionCloseRecords.slice(-10)) {
      console.log(
        `  ${record.symbol} ${record.decision}/${record.signal}`
        + ` emaDirection=${record.emaDirection || 'n/a'}`
        + ` adx=${record.adx ?? 'n/a'}`
        + ` pullbackDistanceAtr=${record.pullbackDistanceAtr ?? 'n/a'}`
        + ` rrFinal=${record.rrFinal ?? 'n/a'}`
        + ` session=${record.session || 'n/a'}`
        + ` regime=${record.regime || 'n/a'}`
        + ` reasons=${record.reasons || 'none'}`,
      );
    }
  }
}

main();
