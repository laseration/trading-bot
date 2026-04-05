const config = require('./config');
const { log } = require('./logger');
const { runBot } = require('./bot');
const { pollTelegramSignals } = require('./telegram');
const { getMt5Health } = require('./mt5Bridge');

const INTERVAL_MS = config.intervalMs;
const PROFILES = config.profiles && config.profiles.length > 0
  ? config.profiles
  : (config.symbols || ["NVDA"]).map((symbol) => ({
      symbol,
      market: symbol.includes('/') ? 'crypto' : 'stock',
      dataSource: 'alpaca',
      signalSource: 'strategy',
      broker: config.paperTradingMode ? 'paper' : 'alpaca',
    }));
const strategyProfiles = PROFILES.filter((profile) => profile.signalSource !== 'telegram');
const telegramProfiles = PROFILES.filter((profile) => profile.signalSource === 'telegram');
const telegramProfilesBySymbol = new Map(
  telegramProfiles.map((profile) => [profile.symbol.toUpperCase(), profile]),
);

function profileUsesMt5(profile) {
  return profile.dataSource === 'mt5' || (!config.paperTradingMode && profile.broker === 'mt5');
}

async function runStartupChecks() {
  const errors = [];

  if (PROFILES.length === 0) {
    errors.push('No profiles are configured');
  }

  if (telegramProfiles.length > 0 && !config.telegram.enabled) {
    errors.push('Telegram signal profiles are configured but TELEGRAM_ENABLED is not true');
  }

  if (config.telegram.enabled) {
    if (!config.telegram.botToken) {
      errors.push('Telegram polling is enabled but TELEGRAM_BOT_TOKEN is missing');
    }

    if (!config.telegram.chatId) {
      errors.push('Telegram polling is enabled but TELEGRAM_SIGNAL_CHAT_ID is missing');
    }
  }

  if (PROFILES.some(profileUsesMt5)) {
    if (!config.mt5Bridge.enabled) {
      errors.push('MT5 is required by the active profiles but MT5_BRIDGE_ENABLED is not true');
    } else {
      try {
        const health = await getMt5Health();
        log(`MT5 bridge health: ${health.status || 'ok'}`);
      } catch (err) {
        errors.push(`MT5 bridge health check failed: ${err.message}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const message of errors) {
      log(`Startup check failed: ${message}`);
    }

    throw new Error('Startup readiness check failed');
  }
}

let isStrategyCycleRunning = false;
let isTelegramPollRunning = false;

async function start() {
  log("Trading bot started...");
  log(`Paper trading mode: ${config.paperTradingMode}`);
  log(`Interval: ${config.intervalMs}ms`);
  log(`Profiles: ${PROFILES.map((profile) => `${profile.symbol}:${profile.signalSource}/${profile.broker}`).join(', ')}`);
  log(`Strategy MA: ${config.strategy.shortMa}/${config.strategy.longMa}`);
  log(`Risk per trade: ${config.risk.riskPerTrade}`);
  log(`Max position size: ${config.risk.maxPositionSize}`);
  log(`Max drawdown: ${config.risk.maxDrawdownPct * 100}%`);

  if (config.telegram.enabled) {
    log(`Telegram signal polling enabled for chat ${config.telegram.chatId || 'unset'}`);
  }

  await runStartupChecks();

  setInterval(async () => {
    if (strategyProfiles.length === 0) {
      return;
    }

    if (isStrategyCycleRunning) {
      log("Skipping cycle: previous still running");
      return;
    }

    isStrategyCycleRunning = true;

    try {
      log("Running bot cycle...");
      for (const profile of strategyProfiles) {
        await runBot(profile);
      }
    } catch (err) {
      log(`Error in bot cycle: ${err.message}`);
    } finally {
      isStrategyCycleRunning = false;
    }
  }, INTERVAL_MS);

  if (config.telegram.enabled && telegramProfiles.length > 0) {
    setInterval(async () => {
      if (isTelegramPollRunning) {
        log("Skipping Telegram poll: previous still running");
        return;
      }

      isTelegramPollRunning = true;

      try {
        const signals = await pollTelegramSignals(telegramProfiles.map((profile) => profile.symbol));

        for (const signal of signals) {
          const profile = telegramProfilesBySymbol.get(signal.symbol.toUpperCase());

          if (!profile) {
            log(`[TELEGRAM] Ignoring signal for unconfigured symbol ${signal.symbol}`);
            continue;
          }

          log(`[TELEGRAM] ${signal.side} ${signal.symbol} from chat ${signal.chatId}`);
          await runBot(profile, {
            signal: signal.side,
            signalSource: signal.source || 'telegram',
            qty: signal.qty,
            rawSignal: signal.text,
          });
        }
      } catch (err) {
        log(`Error in Telegram poll: ${err.message}`);
      } finally {
        isTelegramPollRunning = false;
      }
    }, config.telegram.pollIntervalMs);
  }
}

start().catch((err) => {
  log(`Startup failed: ${err.message}`);
  process.exit(1);
});
