const { log } = require('./logger');
const { reconcileSignalResults } = require('./signals/reconcileSignalResults');
const { publishTradeUpdate } = require('./telegram/publishingService');

async function main() {
  const events = await reconcileSignalResults();

  for (const event of events) {
    await publishTradeUpdate(event);
  }

  log(`[TRACKER] Reconciliation complete: ${events.length} update(s) emitted`);
  console.log(JSON.stringify({
    updates: events.length,
    signalIds: events.map((event) => event.signalId),
  }, null, 2));
}

main().catch((err) => {
  log(`[TRACKER] Reconciliation failed: ${err.message}`);
  process.exit(1);
});
