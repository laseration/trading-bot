const fs = require('fs');
const path = require('path');

const diagnosticsPath = path.join(__dirname, '..', 'logs', 'eurusd-bias-diagnostics.jsonl');
const tradeHistoryPath = path.join(__dirname, '..', 'logs', 'trade-history.csv');

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

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

function incrementCount(map, key) {
  const normalizedKey = key == null || key === '' ? 'UNKNOWN' : String(key);
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + 1);
}

function sortCountsDescending(map) {
  return [...map.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return String(left[0]).localeCompare(String(right[0]));
  });
}

function formatCountMap(map, limit = null) {
  const entries = sortCountsDescending(map);
  const sliced = limit == null ? entries : entries.slice(0, limit);
  return sliced.map(([key, value]) => `${key}: ${value}`);
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRange(values) {
  const numeric = values.map(toNumber).filter((value) => value != null);

  if (numeric.length === 0) {
    return 'n/a';
  }

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const avg = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;

  return `${min.toFixed(3)}..${max.toFixed(3)} avg=${avg.toFixed(3)}`;
}

function buildDiagnosticIndex(events) {
  const index = new Map();

  for (const event of events) {
    if (event.stage !== 'evaluation') {
      continue;
    }

    if (!event.thesisKey) {
      continue;
    }

    if (!index.has(event.thesisKey)) {
      index.set(event.thesisKey, []);
    }

    index.get(event.thesisKey).push(event);
  }

  return index;
}

function buildExecutionIndex(events) {
  const byTicket = new Map();
  const byPositionId = new Map();

  for (const event of events) {
    if (event.stage !== 'execution') {
      continue;
    }

    if (event.ticket != null && event.ticket !== '') {
      byTicket.set(String(event.ticket), event);
    }

    if (event.positionId != null && event.positionId !== '') {
      byPositionId.set(String(event.positionId), event);
    }
  }

  return {
    byTicket,
    byPositionId,
  };
}

function buildTradeThesisKey(row) {
  const symbol = String(row.symbol || '').toUpperCase();
  const side = String(row.side || '').toUpperCase();
  const regime = String(row.regime || '').toUpperCase();
  const entry = toNumber(row.entry_price);

  if (symbol !== 'EURUSD' || !['BUY', 'SELL'].includes(side) || !regime || entry == null) {
    return null;
  }

  const entryZone = Number((Math.round(entry / 0.0005) * 0.0005).toFixed(5));
  return `${symbol}|${side}|${regime}|strong|${entryZone.toFixed(5)}`;
}

function resolveTradeDiagnosticMatch(row, executionIndex, diagnosticIndex) {
  const ticket = row.ticket != null && row.ticket !== '' ? String(row.ticket) : '';
  const positionId = row.position_id != null && row.position_id !== '' ? String(row.position_id) : '';

  let matchedExecution = null;

  if (ticket && executionIndex.byTicket.has(ticket)) {
    matchedExecution = executionIndex.byTicket.get(ticket);
  } else if (positionId && executionIndex.byPositionId.has(positionId)) {
    matchedExecution = executionIndex.byPositionId.get(positionId);
  }

  if (matchedExecution) {
    const thesisKey = matchedExecution.thesisKey || null;
    const evaluationEvents = thesisKey ? (diagnosticIndex.get(thesisKey) || []) : [];
    const evaluationEvent = evaluationEvents[evaluationEvents.length - 1] || null;

    return {
      thesisKey,
      metricsEvent: evaluationEvent || matchedExecution,
    };
  }

  const fallbackThesisKey = buildTradeThesisKey(row);
  const fallbackEvents = fallbackThesisKey ? (diagnosticIndex.get(fallbackThesisKey) || []) : [];
  const fallbackEvent = fallbackEvents[fallbackEvents.length - 1] || null;

  return {
    thesisKey: fallbackThesisKey,
    metricsEvent: fallbackEvent,
  };
}

function summarizeTradeOutcomes(events, tradeRows) {
  const diagnosticIndex = buildDiagnosticIndex(events);
  const executionIndex = buildExecutionIndex(events);
  const outcomeByThesis = new Map();

  for (const row of tradeRows) {
    if (String(row.symbol || '').toUpperCase() !== 'EURUSD' || String(row.strategy_name || '').toLowerCase() !== 'bias') {
      continue;
    }

    const resolvedMatch = resolveTradeDiagnosticMatch(row, executionIndex, diagnosticIndex);
    const thesisKey = resolvedMatch.thesisKey;

    if (!thesisKey) {
      continue;
    }

    const pnl = toNumber(row.pnl);

    if (pnl == null) {
      continue;
    }

    if (!outcomeByThesis.has(thesisKey)) {
      outcomeByThesis.set(thesisKey, {
        count: 0,
        totalPnl: 0,
        emaSeparationAtr: [],
        rsi: [],
        latestBodyAtr: [],
        latestRangeAtr: [],
      });
    }

    const summary = outcomeByThesis.get(thesisKey);
    summary.count += 1;
    summary.totalPnl += pnl;

    const latestEvent = resolvedMatch.metricsEvent;

    if (latestEvent) {
      summary.emaSeparationAtr.push(latestEvent.emaSeparationAtr);
      summary.rsi.push(latestEvent.rsi);
      summary.latestBodyAtr.push(latestEvent.latestBodyAtr);
      summary.latestRangeAtr.push(latestEvent.latestRangeAtr);
    }
  }

  return outcomeByThesis;
}

function formatThesisOutcomeRows(outcomeByThesis, limit = 5) {
  return [...outcomeByThesis.entries()]
    .filter(([, value]) => value.count > 0)
    .sort((left, right) => {
      if (left[1].totalPnl !== right[1].totalPnl) {
        return left[1].totalPnl - right[1].totalPnl;
      }

      return right[1].count - left[1].count;
    })
    .slice(0, limit)
    .map(([key, value]) => ({
      thesisKey: key,
      count: value.count,
      totalPnl: value.totalPnl,
      averagePnl: value.totalPnl / value.count,
      emaSeparationAtr: buildRange(value.emaSeparationAtr),
      rsi: buildRange(value.rsi),
      latestBodyAtr: buildRange(value.latestBodyAtr),
      latestRangeAtr: buildRange(value.latestRangeAtr),
    }));
}

function main() {
  const diagnostics = parseJsonLines(diagnosticsPath)
    .filter((event) => String(event.symbol || '').toUpperCase() === 'EURUSD')
    .filter((event) => String(event.strategyName || '').toLowerCase() === 'bias');
  const tradeRows = parseCsv(tradeHistoryPath);

  const regimeCounts = new Map();
  const decisionCounts = new Map();
  const evaluationThesisCounts = new Map();
  const executionThesisCounts = new Map();

  for (const event of diagnostics) {
    incrementCount(regimeCounts, event.regime);
    incrementCount(decisionCounts, event.decision);

    if (event.thesisKey) {
      if (event.stage === 'evaluation') {
        incrementCount(evaluationThesisCounts, event.thesisKey);
      }

      if (event.stage === 'execution') {
        incrementCount(executionThesisCounts, event.thesisKey);
      }
    }
  }

  const evaluationEvents = diagnostics.filter((event) => event.stage === 'evaluation');
  const executionEvents = diagnostics.filter((event) => event.stage === 'execution');
  const outcomeByThesis = summarizeTradeOutcomes(diagnostics, tradeRows);
  const topLosingTheses = formatThesisOutcomeRows(outcomeByThesis, 5);

  console.log('EURUSD Bias Diagnostics Summary');
  console.log('--------------------------------');
  console.log(`Total evaluation events: ${evaluationEvents.length}`);
  console.log(`Total execution events: ${executionEvents.length}`);
  console.log('');

  console.log('Counts by Regime');
  for (const line of formatCountMap(regimeCounts)) {
    console.log(`- ${line}`);
  }
  console.log('');

  console.log('Counts by Decision');
  for (const line of formatCountMap(decisionCounts)) {
    console.log(`- ${line}`);
  }
  console.log('');

  console.log('Top Repeated Thesis Keys by Evaluation Count');
  for (const line of formatCountMap(evaluationThesisCounts, 10)) {
    console.log(`- ${line}`);
  }
  console.log('');

  console.log('Top Repeated Thesis Keys by Execution Count');
  for (const line of formatCountMap(executionThesisCounts, 10)) {
    console.log(`- ${line}`);
  }
  console.log('');

  console.log('Top Losing Thesis Keys');
  if (topLosingTheses.length === 0) {
    console.log('- none');
  } else {
    for (const row of topLosingTheses) {
      console.log(`- ${row.thesisKey}`);
      console.log(`  count=${row.count} totalPnl=${row.totalPnl.toFixed(2)} avgPnl=${row.averagePnl.toFixed(2)}`);
      console.log(`  emaSeparationAtr=${row.emaSeparationAtr}`);
      console.log(`  rsi=${row.rsi}`);
      console.log(`  latestBodyAtr=${row.latestBodyAtr}`);
      console.log(`  latestRangeAtr=${row.latestRangeAtr}`);
    }
  }
}

main();
