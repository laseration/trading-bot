const path = require("path");
const {
  buildCandidateAudit,
  readFileIfPresent,
  topCounts,
} = require("./candidateAudit");

const repoRoot = path.join(__dirname, "..", "..");
const funnelDecisions = ["HOLD", "WATCH", "REJECT", "APPROVE", "EXECUTED"];
const logPaths = {
  decisionHistoryText: path.join(repoRoot, "logs", "decision-history.jsonl"),
  eurusdBiasDiagnosticsText: path.join(repoRoot, "logs", "eurusd-bias-diagnostics.jsonl"),
  tradeHistoryCsvText: path.join(repoRoot, "logs", "trade-history.csv"),
  tradeEventsCsvText: path.join(repoRoot, "logs", "trade-events.csv"),
  signalResultsText: path.join(repoRoot, "logs", "signal-results.json"),
};

function printSection(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function printCounts(counts, options = {}) {
  const entries = options.keepOrder
    ? Object.entries(counts || {})
    : topCounts(counts || {}, options.limit || 10).map((item) => [item.key, item.count]);

  if (entries.length === 0 || entries.every(([, count]) => Number(count) === 0)) {
    console.log("no data");
    return;
  }

  entries.forEach(([key, count]) => {
    console.log(`${key}: ${count}`);
  });
}

function printTop(title, rows) {
  printSection(title);

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("no data");
    return;
  }

  rows.forEach((row) => console.log(`${row.key}: ${row.count}`));
}

function main() {
  const inputs = Object.fromEntries(
    Object.entries(logPaths).map(([key, filePath]) => [key, readFileIfPresent(filePath)]),
  );
  const audit = buildCandidateAudit(inputs);

  console.log("Candidate Audit");
  console.log("===============");

  printSection("Sources");
  Object.entries(audit.sourcesPresent).forEach(([source, present]) => {
    console.log(`${source}: ${present ? "found" : "missing"}`);
  });

  if (audit.parseErrors.length > 0) {
    printSection("Parse Warnings");
    audit.parseErrors.forEach((error) => {
      const line = error.line == null ? "" : ` line ${error.line}`;
      console.log(`${error.source}${line}: ${error.message}`);
    });
  }

  printSection("Candidate Funnel");
  console.log(`total candidates: ${audit.candidates.totalCandidates}`);
  printCounts(Object.fromEntries(
    funnelDecisions.map((decision) => [decision, audit.candidates.decisionCounts[decision] || 0]),
  ), { keepOrder: true });

  const otherDecisions = Object.fromEntries(
    Object.entries(audit.candidates.decisionCounts)
      .filter(([decision, count]) => !funnelDecisions.includes(decision) && Number(count) > 0),
  );

  if (Object.keys(otherDecisions).length > 0) {
    printSection("Other Candidate Decisions");
    printCounts(otherDecisions);
  }

  printTop("Top Rejection Reasons", audit.candidates.topRejectionReasons);
  printTop("Top Hard Blocks", audit.candidates.topHardBlocks);

  printSection("Approval Score Histogram");
  printCounts(audit.candidates.scoreHistogram, { keepOrder: true });

  printSection("By Symbol");
  printCounts(audit.candidates.bySymbol);

  printSection("By Session");
  printCounts(audit.candidates.bySession);

  printSection("By Regime");
  printCounts(audit.candidates.byRegime);

  printSection("By setupType");
  printCounts(audit.candidates.bySetupType);

  printSection("By strategyName");
  printCounts(audit.candidates.byStrategyName);

  printSection("Reconciliation Coverage");
  console.log(`tracked signals: ${audit.reconciliation.totalTrackedSignals}`);
  console.log(`entered signals: ${audit.reconciliation.enteredSignals}`);
  console.log(`signals with execution identity: ${audit.reconciliation.signalsWithExecutionIdentity}`);
  console.log(`tracked signals missing execution identity: ${audit.reconciliation.trackedSignalsMissingExecutionIdentity}`);
  console.log(`reconciled signals: ${audit.reconciliation.reconciledSignals}`);
  console.log(`reconciliation-ignored records: ${audit.reconciliation.reconciliationIgnoredRecords}`);

  if (audit.reconciliation.reconciliationIgnoredReasons.length > 0) {
    console.log("ignored reasons:");
    audit.reconciliation.reconciliationIgnoredReasons.forEach((row) => {
      console.log(`  ${row.key}: ${row.count}`);
    });
  }

  printSection("Trade Log Coverage");
  console.log(`trade-history rows: ${audit.trades.tradeHistoryRows}`);
  console.log(`trade-event rows: ${audit.trades.tradeEventRows}`);
  console.log(`execution-related trade-event rows: ${audit.trades.executedEventRows}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
