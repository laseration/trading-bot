const fs = require('fs');
const path = require('path');
const { calculateSignalResult } = require('./signals/performanceAggregator');
const { STORE_PATH } = require('./signals/resultTracker');

function readStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return { version: 1, signals: {} };
  }

  const raw = fs.readFileSync(STORE_PATH, 'utf8').trim();
  return raw ? JSON.parse(raw) : { version: 1, signals: {} };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function backupStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return null;
  }

  const backupPath = STORE_PATH.replace(/\.json$/i, `.${Date.now()}.bak.json`);
  fs.copyFileSync(STORE_PATH, backupPath);
  return backupPath;
}

function main() {
  const store = readStore();
  const signals = store && store.signals ? store.signals : {};
  const updated = [];

  for (const [signalId, record] of Object.entries(signals)) {
    if (!record || record.type !== 'signal') {
      continue;
    }

    const nextValue = calculateSignalResult(record);

    if (!Number.isFinite(nextValue)) {
      continue;
    }

    const currentValue = Number(record.pipsOrPointsResult);
    const currentComparable = Number.isFinite(currentValue) ? Number(currentValue.toFixed(1)) : null;
    const nextComparable = Number(nextValue.toFixed(1));

    if (currentComparable === nextComparable) {
      continue;
    }

    record.pipsOrPointsResult = nextComparable;
    updated.push({
      id: signalId,
      symbol: record.symbol || '',
      finalOutcome: record.finalOutcome || '',
      before: currentComparable,
      after: nextComparable,
    });
  }

  if (updated.length === 0) {
    console.log(JSON.stringify({
      updated: 0,
      backupPath: null,
      changes: [],
    }, null, 2));
    return;
  }

  const backupPath = backupStore();
  writeStore(store);

  console.log(JSON.stringify({
    updated: updated.length,
    backupPath,
    changes: updated,
  }, null, 2));
}

main();
