const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));

const defaultProfiles = [
  {
    symbol: "EURUSD",
    market: "forex",
    dataSource: "mt5",
    signalSource: "telegram",
    broker: "mt5",
  },
];

const config = {
  intervalMs: 5000,
  paperTradingMode: true,
  commissionPerTrade: 0,
  symbols: defaultProfiles
    .filter((profile) => profile.signalSource === "strategy")
    .map((profile) => profile.symbol),
  profiles: defaultProfiles,
  alpaca: {
    apiKey: process.env.ALPACA_API_KEY || process.env.ALPACA_KEY || "",
    secretKey: process.env.ALPACA_SECRET_KEY || process.env.ALPACA_SECRET || "",
    dataBaseUrl: process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets",
  },
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === "true",
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_SIGNAL_CHAT_ID || "",
    pollIntervalMs: Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000),
    allowedUpdates: ["message", "channel_post"],
  },
  mt5Bridge: {
    enabled: process.env.MT5_BRIDGE_ENABLED === "true",
    baseUrl: process.env.MT5_BRIDGE_BASE_URL || "http://127.0.0.1:5001",
    timeoutMs: Number(process.env.MT5_BRIDGE_TIMEOUT_MS || 5000),
    deviationPoints: Number(process.env.MT5_DEVIATION_POINTS || 20),
    magic: Number(process.env.MT5_MAGIC || 5151001),
    commentPrefix: process.env.MT5_COMMENT_PREFIX || "trading-bot",
  },
  strategy: {
    shortMa: 20,
    longMa: 50,
  },
  risk: {
    riskPerTrade: 0.01,
    maxPositionSize: 10,
    maxDrawdownPct: 0.1,
  },
};

module.exports = config;
