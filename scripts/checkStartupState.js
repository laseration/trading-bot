const config = require('../src/config');
const { getLatestMt5Quote, getMt5Health } = require('../src/mt5Bridge');
const { readStartupState } = require('../src/startupRecovery');

function summarizeProcess(info) {
  if (!info) {
    return { running: false };
  }

  return {
    running: true,
    pid: info.ProcessId,
    parentPid: info.ParentProcessId,
    name: info.Name,
    executablePath: info.ExecutablePath,
    commandLine: info.CommandLine,
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return 'n/a';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return `${(ms / 60000).toFixed(1)}m`;
}

function printSection(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

async function withRetries(label, fn) {
  const retries = Math.max(1, Number(config.startup.bridgeHealthRetries || 3));
  const delayMs = Math.max(0, Number(config.startup.bridgeHealthRetryDelayMs || 2000));
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await fn();
      console.log(`${label} attempt ${attempt}/${retries}: ok`);
      return result;
    } catch (err) {
      lastError = err;
      console.log(`${label} attempt ${attempt}/${retries}: failed: ${err.message}`);

      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function main() {
  const state = readStartupState();

  printSection('Startup config', {
    tradingEnv: process.env.TRADING_ENV || process.env.BOT_ENV || '',
    startup: config.startup,
    mt5Bridge: {
      enabled: config.mt5Bridge.enabled,
      baseUrl: config.mt5Bridge.baseUrl,
      timeoutMs: config.mt5Bridge.timeoutMs,
      requireConnected: config.mt5Bridge.requireConnected,
      maxQuoteAgeMs: config.mt5Bridge.maxQuoteAgeMs,
      maxFutureQuoteSkewMs: config.mt5Bridge.maxFutureQuoteSkewMs,
      autoStartHttpBridge: config.mt5Bridge.autoStartHttpBridge,
      autoStartTerminal: config.mt5Bridge.autoStartTerminal,
    },
  });

  printSection('Locks and PIDs', {
    paths: state.paths,
    botLock: state.botLock,
    botProcess: summarizeProcess(state.botProcess),
    bridgeLock: state.bridgeLock,
    bridgeLockProcess: summarizeProcess(state.bridgeLockProcess),
    bridgePid: state.bridgePid,
    bridgePidProcess: summarizeProcess(state.bridgePidProcess),
  });

  if (!config.mt5Bridge.enabled) {
    console.log('\nMT5 bridge disabled; no bridge health or quote checks run.');
    return;
  }

  try {
    const health = await withRetries('Bridge health', () => getMt5Health());
    printSection('Bridge health', {
      status: health.status,
      connected: health.connected,
      server: health.server,
      accountLogin: health.accountLogin,
      heartbeatAgeMs: health.heartbeat && health.heartbeat.ageMs,
    });
  } catch (err) {
    printSection('Bridge health', {
      ok: false,
      error: err.message,
    });
  }

  const mt5Profiles = (config.profiles || []).filter((profile) => (
    profile.dataSource === 'mt5' || profile.broker === 'mt5'
  ));
  const symbols = [...new Set(mt5Profiles.map((profile) => profile.symbol).filter(Boolean))];

  for (const symbol of symbols) {
    try {
      const quote = await withRetries(`Quote ${symbol}`, () => getLatestMt5Quote(symbol));
      const quoteTimestampMs = Number(quote.time) * 1000;
      const futureSkewMs = Math.max(0, quoteTimestampMs - Date.now());
      const quoteAgeMs = Math.max(0, Date.now() - quoteTimestampMs);

      printSection(`Quote ${symbol}`, {
        ok: true,
        bid: quote.bid,
        ask: quote.ask,
        price: quote.price,
        time: quote.time,
        age: formatDuration(quoteAgeMs),
        futureSkew: formatDuration(futureSkewMs),
        stale: Number.isFinite(config.mt5Bridge.maxQuoteAgeMs)
          && config.mt5Bridge.maxQuoteAgeMs > 0
          && quoteAgeMs > config.mt5Bridge.maxQuoteAgeMs,
      });
    } catch (err) {
      printSection(`Quote ${symbol}`, {
        ok: false,
        error: err.message,
      });
    }
  }
}

main().catch((err) => {
  console.error(`Startup state check failed: ${err.message}`);
  process.exit(1);
});
