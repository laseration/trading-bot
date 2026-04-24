const fs = require('fs');
const path = require('path');

const tradeHistoryPath = path.join(__dirname, '..', 'logs', 'trade-history.csv');
const EURUSD_ZONE_SIZE = 0.0005;

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < String(line || '').length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();

  if (!raw) {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] ?? '';
      return row;
    }, {});
  });
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToZone(price, zoneSize = EURUSD_ZONE_SIZE) {
  if (!(Number.isFinite(price) && price > 0) || !(zoneSize > 0)) {
    return null;
  }

  return Number((Math.round(price / zoneSize) * zoneSize).toFixed(5));
}

function normalizeKey(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.toUpperCase() : 'UNKNOWN';
}

function summarizeBy(rows, keySelector) {
  const summary = new Map();

  for (const row of rows) {
    const key = keySelector(row);
    const current = summary.get(key) || { count: 0, wins: 0, losses: 0, pnl: 0 };
    const pnl = toNumber(row.pnl) || 0;

    current.count += 1;
    current.pnl += pnl;

    if (pnl > 0) {
      current.wins += 1;
    } else if (pnl < 0) {
      current.losses += 1;
    }

    summary.set(key, current);
  }

  return [...summary.entries()].sort((left, right) => {
    if (left[1].pnl !== right[1].pnl) {
      return left[1].pnl - right[1].pnl;
    }

    if (right[1].count !== left[1].count) {
      return right[1].count - left[1].count;
    }

    return String(left[0]).localeCompare(String(right[0]));
  });
}

function printSection(title, entries) {
  console.log(title);

  if (entries.length === 0) {
    console.log('- none');
    console.log('');
    return;
  }

  for (const [key, value] of entries) {
    console.log(
      `- ${key}: trades=${value.count} wins=${value.wins} losses=${value.losses} pnl=${value.pnl.toFixed(2)}`,
    );
  }

  console.log('');
}

function sumPnl(rows = []) {
  return rows.reduce((total, row) => total + (toNumber(row.pnl) || 0), 0);
}

function summarizeApprovalBuckets(rows = []) {
  return summarizeBy(rows, (row) => {
    const score = toNumber(row.approval_score);

    if (score == null) {
      return 'UNKNOWN';
    }

    if (score < 50) {
      return '<50';
    }

    if (score < 60) {
      return '50-59';
    }

    if (score < 70) {
      return '60-69';
    }

    if (score < 80) {
      return '70-79';
    }

    if (score < 90) {
      return '80-89';
    }

    return '90+';
  });
}

function summarizeRepeatedZones(rows = []) {
  const summary = new Map();

  for (const row of rows) {
    const entry = toNumber(row.entry_price);
    const zone = roundToZone(entry);

    if (zone == null) {
      continue;
    }

    const key = `${normalizeKey(row.side)} | ${normalizeKey(row.regime)} | ${zone.toFixed(5)}`;
    const current = summary.get(key) || { count: 0, wins: 0, losses: 0, pnl: 0 };
    const pnl = toNumber(row.pnl) || 0;
    current.count += 1;
    current.pnl += pnl;

    if (pnl > 0) {
      current.wins += 1;
    } else if (pnl < 0) {
      current.losses += 1;
    }

    summary.set(key, current);
  }

  return [...summary.entries()]
    .filter(([, value]) => value.count > 1)
    .sort((left, right) => {
      if (left[1].pnl !== right[1].pnl) {
        return left[1].pnl - right[1].pnl;
      }

      return right[1].count - left[1].count;
    });
}

function main() {
  const rows = parseCsv(tradeHistoryPath);
  const totalPnl = sumPnl(rows);
  const liveStrategyRows = rows.filter((row) => normalizeKey(row.source_type) === 'STRATEGY' && normalizeKey(row.strategy_name) !== 'VALIDATION');
  const eurusdBiasRows = rows
    .filter((row) => normalizeKey(row.symbol) === 'EURUSD')
    .filter((row) => normalizeKey(row.strategy_name) === 'BIAS');
  const eurusdBiasBuyRangingRows = eurusdBiasRows
    .filter((row) => normalizeKey(row.side) === 'BUY')
    .filter((row) => normalizeKey(row.regime) === 'RANGING');
  const eurusdBiasBuyUnstableRows = eurusdBiasRows
    .filter((row) => normalizeKey(row.side) === 'BUY')
    .filter((row) => normalizeKey(row.regime) === 'UNSTABLE');
  const repeatedZones = summarizeRepeatedZones(eurusdBiasRows);

  console.log('Trade History Summary');
  console.log('---------------------');
  console.log(`Rows: ${rows.length}`);
  console.log(`Total PnL: ${totalPnl.toFixed(2)}`);
  console.log(`Live strategy rows excluding validation: ${liveStrategyRows.length}`);
  console.log('');

  printSection('By Symbol', summarizeBy(rows, (row) => normalizeKey(row.symbol)));
  printSection('By Source Type', summarizeBy(rows, (row) => normalizeKey(row.source_type)));
  printSection(
    'By Strategy Name',
    summarizeBy(rows, (row) => normalizeKey(row.strategy_name)),
  );
  printSection(
    'By Symbol + Strategy + Side + Regime',
    summarizeBy(
      rows,
      (row) => `${normalizeKey(row.symbol)} | ${normalizeKey(row.strategy_name)} | ${normalizeKey(row.side)} | ${normalizeKey(row.regime)}`,
    ),
  );
  printSection('By Close Reason', summarizeBy(rows, (row) => normalizeKey(row.close_reason)));
  printSection('Approval Score Buckets', summarizeApprovalBuckets(rows));
  printSection('Session Summary', summarizeBy(rows, (row) => normalizeKey(row.session)));

  console.log('EURUSD Bias Repeated Zones (0.0005)');
  if (repeatedZones.length === 0) {
    console.log('- none');
  } else {
    for (const [key, value] of repeatedZones) {
      console.log(
        `- ${key}: trades=${value.count} wins=${value.wins} losses=${value.losses} pnl=${value.pnl.toFixed(2)}`,
      );
    }
  }
  console.log('');

  console.log('Worst Losing Repeated Zones');
  if (repeatedZones.length === 0) {
    console.log('- none');
  } else {
    for (const [key, value] of repeatedZones.slice(0, 5)) {
      console.log(
        `- ${key}: trades=${value.count} wins=${value.wins} losses=${value.losses} pnl=${value.pnl.toFixed(2)}`,
      );
    }
  }
  console.log('');

  console.log('EURUSD Bias BUY RANGING');
  console.log(
    `- trades=${eurusdBiasBuyRangingRows.length} pnl=${sumPnl(eurusdBiasBuyRangingRows).toFixed(2)} `
    + `wins=${eurusdBiasBuyRangingRows.filter((row) => (toNumber(row.pnl) || 0) > 0).length} `
    + `losses=${eurusdBiasBuyRangingRows.filter((row) => (toNumber(row.pnl) || 0) < 0).length}`,
  );
  console.log('');

  console.log('EURUSD Bias BUY UNSTABLE');
  console.log(
    `- trades=${eurusdBiasBuyUnstableRows.length} pnl=${sumPnl(eurusdBiasBuyUnstableRows).toFixed(2)} `
    + `wins=${eurusdBiasBuyUnstableRows.filter((row) => (toNumber(row.pnl) || 0) > 0).length} `
    + `losses=${eurusdBiasBuyUnstableRows.filter((row) => (toNumber(row.pnl) || 0) < 0).length}`,
  );
}

main();
