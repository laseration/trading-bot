const fs = require("fs");
const path = require("path");

const initialEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(filePath, options = {}) {
  const { override = true } = options;

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

    if (!key) {
      continue;
    }

    if (!override && process.env[key] !== undefined) {
      continue;
    }

    if (override && initialEnvKeys.has(key) && process.env[key] !== undefined) {
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

function resolveEnvMode() {
  return String(process.env.TRADING_ENV || process.env.BOT_ENV || "")
    .trim()
    .toLowerCase();
}

const repoRoot = path.join(__dirname, "..");
loadEnvFile(path.join(repoRoot, ".env.shared"), { override: true });

const envMode = resolveEnvMode();

if (envMode) {
  loadEnvFile(path.join(repoRoot, `.env.${envMode}`), { override: true });
} else {
  loadEnvFile(path.join(repoRoot, ".env"), { override: true });
}

function envFlag(name, defaultValue = false) {
  const rawValue = process.env[name];

  if (rawValue == null || rawValue === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(rawValue).trim().toLowerCase());
}

function envOptionalNumber(name, defaultValue = null) {
  const rawValue = process.env[name];

  if (rawValue == null || String(rawValue).trim() === "") {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function envList(name, defaultValue = []) {
  const rawValue = process.env[name];

  if (rawValue == null || String(rawValue).trim() === "") {
    return Array.isArray(defaultValue) ? [...defaultValue] : [];
  }

  return String(rawValue)
    .split(/[,\n;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function envListAllowBlank(name, defaultValue = []) {
  const rawValue = process.env[name];

  if (rawValue == null) {
    return Array.isArray(defaultValue) ? [...defaultValue] : [];
  }

  if (String(rawValue).trim() === '') {
    return [];
  }

  return String(rawValue)
    .split(/[,\n;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function envKeyValueMap(name) {
  const rawValue = process.env[name];

  if (rawValue == null || String(rawValue).trim() === "") {
    return {};
  }

  return String(rawValue)
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separatorIndex = entry.indexOf(":");

      if (separatorIndex <= 0) {
        return accumulator;
      }

      const key = entry.slice(0, separatorIndex).trim().toUpperCase();
      const value = entry.slice(separatorIndex + 1).trim();

      if (key && value) {
        accumulator[key] = value;
      }

      return accumulator;
    }, {});
}

function envObjectNumbers(name, defaults = {}) {
  const entries = envKeyValueMap(name);
  return Object.entries({ ...defaults, ...entries }).reduce((accumulator, [key, value]) => {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      accumulator[String(key).toUpperCase()] = parsed;
    }

    return accumulator;
  }, {});
}

function envUpper(name, defaultValue = "") {
  const rawValue = process.env[name];
  return rawValue == null || String(rawValue).trim() === ""
    ? String(defaultValue || "").trim().toUpperCase()
    : String(rawValue).trim().toUpperCase();
}

function inferMarket(symbol) {
  const normalized = String(symbol || "").toUpperCase();

  if (normalized.includes("OIL") || normalized.includes("XAU") || normalized.includes("XAG")) {
    return "commodity";
  }

  return "forex";
}

function buildSymbolSetting(symbol, defaults = {}) {
  const prefix = `SYMBOL_${String(symbol || "").toUpperCase()}_`;

  return {
    mode: envUpper(`${prefix}MODE`, defaults.mode || "HYBRID"),
    primarySource: envUpper(`${prefix}PRIMARY_SOURCE`, defaults.primarySource || "STRATEGY"),
    allowTelegramTrigger: envFlag(`${prefix}ALLOW_TELEGRAM_TRIGGER`, defaults.allowTelegramTrigger ?? true),
    requireTrendAlignment: envFlag(`${prefix}REQUIRE_TREND_ALIGNMENT`, defaults.requireTrendAlignment ?? true),
    requireStructuredSignal: envFlag(`${prefix}REQUIRE_STRUCTURED_SIGNAL`, defaults.requireStructuredSignal ?? true),
    requireTakeProfit: envFlag(`${prefix}REQUIRE_TAKE_PROFIT`, defaults.requireTakeProfit ?? true),
    blockNearNews: envFlag(`${prefix}BLOCK_NEAR_NEWS`, defaults.blockNearNews ?? true),
    useSignalConfluence: envFlag(`${prefix}USE_SIGNAL_CONFLUENCE`, defaults.useSignalConfluence ?? false),
    allowedSessions: envList(`${prefix}SESSIONS`, defaults.allowedSessions || ["LONDON", "NEWYORK"]).map((value) => value.toUpperCase()),
    minRiskReward: Number(process.env[`${prefix}MIN_RR`] || defaults.minRiskReward || 1.3),
    minTp1RiskReward: Number(process.env[`${prefix}MIN_TP1_RR`] || defaults.minTp1RiskReward || defaults.minRiskReward || 1.0),
    minFinalRiskReward: Number(process.env[`${prefix}MIN_FINAL_RR`] || defaults.minFinalRiskReward || defaults.minRiskReward || 1.3),
    maxSpreadPct: Number(process.env[`${prefix}MAX_SPREAD_PCT`] || defaults.maxSpreadPct || 0.0003),
    maxSignalAgeMinutes: Number(process.env[`${prefix}MAX_SIGNAL_AGE_MINUTES`] || defaults.maxSignalAgeMinutes || 20),
    maxEntryDeviationPct: Number(process.env[`${prefix}MAX_ENTRY_DEVIATION_PCT`] || defaults.maxEntryDeviationPct || 0.002),
    minApproveScore: Number(process.env[`${prefix}MIN_APPROVE_SCORE`] || defaults.minApproveScore || 60),
    minWatchScore: Number(process.env[`${prefix}MIN_WATCH_SCORE`] || defaults.minWatchScore || 45),
    riskPerTrade: Number(process.env[`${prefix}RISK_PER_TRADE`] || defaults.riskPerTrade || process.env.RISK_PER_TRADE || 0.01),
    maxPositionSize: Number(process.env[`${prefix}MAX_POSITION_SIZE`] || defaults.maxPositionSize || 10),
    maxDailyLossPct: Number(process.env[`${prefix}MAX_DAILY_LOSS_PCT`] || defaults.maxDailyLossPct || 0.03),
    maxOpenTrades: Number(process.env[`${prefix}MAX_OPEN_TRADES`] || defaults.maxOpenTrades || 1),
  };
}

function applyDemoStressOverrides(config) {
  const isDemoStressMode = envMode === "demo" && envFlag("DEMO_STRESS_MODE", false);
  const overrides = [];

  config.demoStress = {
    active: isDemoStressMode,
    overrides,
  };

  if (!isDemoStressMode) {
    return config;
  }

  const eurusd = config.hybrid.symbols.EURUSD;
  const xauusd = config.hybrid.symbols.XAUUSD;

  const learningMinScoreToTrade = envOptionalNumber("DEMO_STRESS_LEARNING_MIN_SCORE_TO_TRADE", 40);
  const eurusdMinApproveScore = envOptionalNumber("DEMO_STRESS_EURUSD_MIN_APPROVE_SCORE", 56);
  const xauusdMinApproveScore = envOptionalNumber("DEMO_STRESS_XAUUSD_MIN_APPROVE_SCORE", 58);
  const eurusdUseSignalConfluence = envFlag("DEMO_STRESS_EURUSD_USE_SIGNAL_CONFLUENCE", false);
  const xauusdUseSignalConfluence = envFlag("DEMO_STRESS_XAUUSD_USE_SIGNAL_CONFLUENCE", false);
  const biasEntryBodyAtrMin = envOptionalNumber("DEMO_STRESS_BIAS_ENTRY_BODY_ATR_MIN", 0.08);
  const biasEntryRangeAtrMin = envOptionalNumber("DEMO_STRESS_BIAS_ENTRY_RANGE_ATR_MIN", 0.18);
  const meanReversionRsiBuyMax = envOptionalNumber("DEMO_STRESS_MEAN_REVERSION_RSI_BUY_MAX", 40);
  const meanReversionRsiSellMin = envOptionalNumber("DEMO_STRESS_MEAN_REVERSION_RSI_SELL_MIN", 60);

  if (learningMinScoreToTrade != null) {
    config.learning.minScoreToTrade = learningMinScoreToTrade;
    overrides.push(`SIGNAL_LEARNING_MIN_SCORE_TO_TRADE=${learningMinScoreToTrade}`);
  }

  if (eurusd) {
    eurusd.minApproveScore = eurusdMinApproveScore;
    eurusd.useSignalConfluence = eurusdUseSignalConfluence;
    overrides.push(`SYMBOL_EURUSD_MIN_APPROVE_SCORE=${eurusdMinApproveScore}`);
    overrides.push(`SYMBOL_EURUSD_USE_SIGNAL_CONFLUENCE=${eurusdUseSignalConfluence}`);
  }

  if (xauusd) {
    xauusd.minApproveScore = xauusdMinApproveScore;
    xauusd.useSignalConfluence = xauusdUseSignalConfluence;
    overrides.push(`SYMBOL_XAUUSD_MIN_APPROVE_SCORE=${xauusdMinApproveScore}`);
    overrides.push(`SYMBOL_XAUUSD_USE_SIGNAL_CONFLUENCE=${xauusdUseSignalConfluence}`);
  }

  config.strategy.biasEntryBodyAtrMin = biasEntryBodyAtrMin;
  config.strategy.biasEntryRangeAtrMin = biasEntryRangeAtrMin;
  config.strategy.meanReversionRsiBuyMax = meanReversionRsiBuyMax;
  config.strategy.meanReversionRsiSellMin = meanReversionRsiSellMin;
  overrides.push(`STRATEGY_BIAS_ENTRY_BODY_ATR_MIN=${biasEntryBodyAtrMin}`);
  overrides.push(`STRATEGY_BIAS_ENTRY_RANGE_ATR_MIN=${biasEntryRangeAtrMin}`);
  overrides.push(`STRATEGY_MEAN_REVERSION_RSI_BUY_MAX=${meanReversionRsiBuyMax}`);
  overrides.push(`STRATEGY_MEAN_REVERSION_RSI_SELL_MIN=${meanReversionRsiSellMin}`);

  return config;
}

function buildMt5TelegramProfiles() {
  const symbols = envListAllowBlank("MT5_TELEGRAM_SYMBOLS", ["EURUSD", "XAUUSD"])
    .map((symbol) => symbol.toUpperCase());

  return symbols.map((symbol) => ({
    id: `telegram:${symbol}`,
    symbol,
    market: inferMarket(symbol),
    dataSource: "mt5",
    signalSource: "telegram",
    broker: "mt5",
  }));
}

function buildMt5StrategyProfiles() {
  const symbols = envListAllowBlank("MT5_STRATEGY_SYMBOLS", [])
    .map((symbol) => symbol.toUpperCase());
  const strategyAssignments = envKeyValueMap("MT5_STRATEGY_ASSIGNMENTS");
  const dataSourceAssignments = envKeyValueMap("STRATEGY_DATA_SOURCE_ASSIGNMENTS");

  return symbols.map((symbol) => ({
    id: `strategy:${symbol}`,
    symbol,
    market: inferMarket(symbol),
    dataSource: dataSourceAssignments[symbol] || "mt5",
    signalSource: "strategy",
    broker: "mt5",
    strategyName: strategyAssignments[symbol] || process.env.STRATEGY_NAME || "trend",
  }));
}

const defaultProfiles = [
  ...buildMt5TelegramProfiles(),
  ...buildMt5StrategyProfiles(),
];

const config = {
  intervalMs: 5000,
  paperTradingMode: envFlag("PAPER_TRADING_MODE", true),
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
  alphaVantage: {
    apiKey: process.env.ALPHA_VANTAGE_API_KEY || "",
    baseUrl: process.env.ALPHA_VANTAGE_BASE_URL || "https://www.alphavantage.co/query",
    marketDataCacheMs: Number(process.env.ALPHA_VANTAGE_MARKET_CACHE_MS || 900000),
    minRequestSpacingMs: Number(process.env.ALPHA_VANTAGE_MIN_REQUEST_SPACING_MS || 15000),
    forexOutputSize: process.env.ALPHA_VANTAGE_FOREX_OUTPUTSIZE || "compact",
    preferredTimeframe: process.env.ALPHA_VANTAGE_PREFERRED_TIMEFRAME || "D1",
  },
  telegram: {
    enabled: envFlag("TELEGRAM_ENABLED", false),
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_SIGNAL_CHAT_ID || "",
    postBotToken: process.env.TELEGRAM_POST_BOT_TOKEN || "",
    postChannelId: process.env.TELEGRAM_POST_CHANNEL_ID || "",
    brandLogoPath: process.env.TELEGRAM_BRAND_LOGO_PATH || "",
    pollIntervalMs: Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000),
    requestTimeoutMs: Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS || 15000),
    allowedUpdates: ["message", "channel_post", "edited_message", "edited_channel_post"],
    freeSignalsLikelyDelayed: envFlag("TELEGRAM_FREE_SIGNALS_LIKELY_DELAYED", true),
    delayedSignalWarningMinutes: Number(process.env.TELEGRAM_DELAYED_SIGNAL_WARNING_MINUTES || 20),
    similarityWindowMinutes: Number(process.env.TELEGRAM_SIMILARITY_WINDOW_MINUTES || 240),
    similarityMinScore: Number(process.env.TELEGRAM_SIMILARITY_MIN_SCORE || 2.4),
    similarityTextThreshold: Number(process.env.TELEGRAM_SIMILARITY_TEXT_THRESHOLD || 0.42),
    similarityPriceTolerancePct: Number(process.env.TELEGRAM_SIMILARITY_PRICE_TOLERANCE_PCT || 0.003),
  },
  news: {
    enabled: envFlag("NEWS_TRADING_ENABLED", false),
    apiKey: process.env.NEWS_API_KEY || "",
    alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || "",
    baseUrl: process.env.NEWS_API_BASE_URL || "https://newsapi.org/v2",
    alphaVantageBaseUrl: process.env.ALPHA_VANTAGE_NEWS_BASE_URL || "https://www.alphavantage.co/query",
    searchQuery: process.env.NEWS_SEARCH_QUERY || "forex OR currency OR gold OR Federal Reserve OR ECB OR Bank of England OR Bank of Japan OR inflation OR rates",
    pollIntervalMs: Number(process.env.NEWS_POLL_INTERVAL_MS || 300000),
    lookbackMinutes: Number(process.env.NEWS_LOOKBACK_MINUTES || 180),
    sentimentThreshold: Number(process.env.NEWS_SENTIMENT_THRESHOLD || 0.7),
    relevanceThreshold: Number(process.env.NEWS_RELEVANCE_THRESHOLD || 0.45),
    maxArticlesPerPoll: Number(process.env.NEWS_MAX_ARTICLES_PER_POLL || 12),
    maxSignalsPerPoll: Number(process.env.NEWS_MAX_SIGNALS_PER_POLL || 3),
    fetchCacheMs: Number(process.env.NEWS_FETCH_CACHE_MS || 300000),
    symbols: envList("NEWS_SYMBOLS", ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "XAUUSD", "XAGUSD", "CL-OIL"])
      .map((symbol) => symbol.toUpperCase()),
    stopLossPct: Number(process.env.NEWS_STOP_LOSS_PCT || 0.0035),
    rewardRiskRatio: Number(process.env.NEWS_REWARD_RISK_RATIO || 2),
    allowedRiskLevels: envList("NEWS_ALLOWED_RISK_LEVELS", ["LOW", "MEDIUM"])
      .map((value) => value.toUpperCase()),
    backtestFile: process.env.NEWS_BACKTEST_FILE || path.join(__dirname, "..", "runtime", "news-backtest-sample.json"),
  },
  mt5Bridge: {
    enabled: envFlag("MT5_BRIDGE_ENABLED", false),
    baseUrl: process.env.MT5_BRIDGE_BASE_URL || "http://127.0.0.1:5001",
    timeoutMs: Number(process.env.MT5_BRIDGE_TIMEOUT_MS || 5000),
    maxQuoteAgeMs: Number(process.env.MT5_MAX_QUOTE_AGE_MS || 120000),
    maxFutureQuoteSkewMs: Number(process.env.MT5_MAX_FUTURE_QUOTE_SKEW_MS || 21600000),
    requireConnected: envFlag("MT5_REQUIRE_CONNECTED", true),
    deviationPoints: Number(process.env.MT5_DEVIATION_POINTS || 20),
    magic: Number(process.env.MT5_MAGIC || 5151001),
    commentPrefix: process.env.MT5_COMMENT_PREFIX || "trading-bot",
    autoStartHttpBridge: envFlag("MT5_AUTO_START_HTTP_BRIDGE", false),
    autoStartTerminal: envFlag("MT5_AUTO_START_TERMINAL", false),
  },
  strategy: {
    name: process.env.STRATEGY_NAME || "trend",
    shortMa: 20,
    longMa: 50,
    timeframe: process.env.STRATEGY_TIMEFRAME || "M15",
    newBarOnly: envFlag("STRATEGY_NEW_BAR_ONLY", true),
    confirmationTimeframes: envList("STRATEGY_CONFIRMATION_TIMEFRAMES", ["H1"]),
    minConfirmations: Number(process.env.STRATEGY_MIN_CONFIRMATIONS || 0),
    lookbackBars: Number(process.env.STRATEGY_LOOKBACK_BARS || 250),
    adxPeriod: Number(process.env.STRATEGY_ADX_PERIOD || 14),
    adxMin: Number(process.env.STRATEGY_ADX_MIN || 15),
    atrPeriod: Number(process.env.STRATEGY_ATR_PERIOD || 14),
    atrStopMultiplier: Number(process.env.STRATEGY_ATR_STOP_MULTIPLIER || 1.8),
    atrTakeProfitMultiplier: Number(process.env.STRATEGY_ATR_TAKE_PROFIT_MULTIPLIER || 3.6),
    rsiPeriod: Number(process.env.STRATEGY_RSI_PERIOD || 14),
    rsiLongMin: Number(process.env.STRATEGY_RSI_LONG_MIN || 40),
    rsiShortMax: Number(process.env.STRATEGY_RSI_SHORT_MAX || 60),
    minAtrPct: Number(process.env.STRATEGY_MIN_ATR_PCT || 0.0003),
    sessionStartHourUtc: Number(process.env.STRATEGY_SESSION_START_HOUR_UTC || 0),
    sessionEndHourUtc: Number(process.env.STRATEGY_SESSION_END_HOUR_UTC || 24),
    newsCooldownMinutes: Number(process.env.STRATEGY_NEWS_COOLDOWN_MINUTES || 20),
    breakoutLookback: Number(process.env.STRATEGY_BREAKOUT_LOOKBACK || 20),
    bollingerPeriod: Number(process.env.STRATEGY_BOLLINGER_PERIOD || 20),
    bollingerStdDev: Number(process.env.STRATEGY_BOLLINGER_STD_DEV || 2),
    meanReversionRsiBuyMax: Number(process.env.STRATEGY_MEAN_REVERSION_RSI_BUY_MAX || 35),
    meanReversionRsiSellMin: Number(process.env.STRATEGY_MEAN_REVERSION_RSI_SELL_MIN || 65),
    biasPullbackAtrMultiplier: Number(process.env.STRATEGY_BIAS_PULLBACK_ATR_MULTIPLIER || 0.75),
    biasTrendBufferAtrMultiplier: Number(process.env.STRATEGY_BIAS_TREND_BUFFER_ATR_MULTIPLIER || 0.2),
    biasRsiLongMin: Number(process.env.STRATEGY_BIAS_RSI_LONG_MIN || 45),
    biasRsiShortMax: Number(process.env.STRATEGY_BIAS_RSI_SHORT_MAX || 55),
    biasEntryBodyAtrMin: Number(process.env.STRATEGY_BIAS_ENTRY_BODY_ATR_MIN || 0.12),
    biasEntryRangeAtrMin: Number(process.env.STRATEGY_BIAS_ENTRY_RANGE_ATR_MIN || 0.25),
    biasEntryEmaVelocityAtrMin: Number(process.env.STRATEGY_BIAS_ENTRY_EMA_VELOCITY_ATR_MIN || 0.03),
    biasEntryContinuationAtrMin: Number(process.env.STRATEGY_BIAS_ENTRY_CONTINUATION_ATR_MIN || 0.08),
    eurusdBiasRangingPullbackAtrExtraAllowance: Number(process.env.STRATEGY_EURUSD_BIAS_RANGING_PULLBACK_ATR_EXTRA_ALLOWANCE || 0.08),
    eurusdBiasRangingMinEmaSeparationAtr: Number(process.env.STRATEGY_EURUSD_BIAS_RANGING_MIN_EMA_SEPARATION_ATR || 0.12),
    eurusdBiasRangingRsiBuffer: Number(process.env.STRATEGY_EURUSD_BIAS_RANGING_RSI_BUFFER || 5),
  },
  risk: {
    riskPerTrade: Number(process.env.RISK_PER_TRADE || 0.01),
    maxPositionSize: 10,
    maxDrawdownPct: 0.1,
    maxDailyLossPct: Number(process.env.MAX_DAILY_LOSS_PCT || 0.03),
    minPositionSize: Number(process.env.MIN_POSITION_SIZE || 0.01),
    positionSizeStep: Number(process.env.POSITION_SIZE_STEP || 0.01),
    requireStopDistance: envFlag("RISK_REQUIRE_STOP_DISTANCE", true),
  },
  sourcePerformance: {
    lookbackDays: Number(process.env.SOURCE_PERFORMANCE_LOOKBACK_DAYS || 30),
    minSettledSignals: Number(process.env.SOURCE_PERFORMANCE_MIN_SETTLED_SIGNALS || 5),
    minWinRateToPublish: envOptionalNumber("SOURCE_PERFORMANCE_MIN_WIN_RATE_TO_PUBLISH", null),
  },
  learning: {
    enabled: envFlag("SIGNAL_LEARNING_ENABLED", true),
    lookbackDays: Number(process.env.SIGNAL_LEARNING_LOOKBACK_DAYS || 45),
    minSettledSignals: Number(process.env.SIGNAL_LEARNING_MIN_SETTLED_SIGNALS || 5),
    minScoreToTrade: envOptionalNumber("SIGNAL_LEARNING_MIN_SCORE_TO_TRADE", null),
    minScoreToPublish: envOptionalNumber("SIGNAL_LEARNING_MIN_SCORE_TO_PUBLISH", null),
  },
  resultTracking: {
    reconciliationIntervalMs: Number(process.env.RESULT_RECONCILIATION_INTERVAL_MS || 60000),
    reconciliationLookbackDays: Number(process.env.RESULT_RECONCILIATION_LOOKBACK_DAYS || 14),
  },
  publicSignals: {
    enabled: envFlag("PUBLIC_SIGNALS_ENABLED", true),
    postingIntervalMs: Number(process.env.PUBLIC_SIGNALS_POSTING_INTERVAL_MS || 60000),
    maxPostsPerHour: Number(process.env.PUBLIC_SIGNALS_MAX_POSTS_PER_HOUR || 2),
    minMinutesBetweenPosts: Number(process.env.PUBLIC_SIGNALS_MIN_MINUTES_BETWEEN_POSTS || 30),
    staleAfterMinutes: Number(process.env.PUBLIC_SIGNALS_STALE_AFTER_MINUTES || 90),
    duplicateWindowMinutes: Number(process.env.PUBLIC_SIGNALS_DUPLICATE_WINDOW_MINUTES || 180),
    minScoreImprovementForDuplicate: Number(process.env.PUBLIC_SIGNALS_DUPLICATE_MIN_SCORE_IMPROVEMENT || 8),
    minApproveScore: Number(process.env.PUBLIC_SIGNALS_MIN_APPROVE_SCORE || 60),
    maxEntryDeviationPct: Number(process.env.PUBLIC_SIGNALS_MAX_ENTRY_DEVIATION_PCT || 0.0015),
    lowRiskMinScore: Number(process.env.PUBLIC_SIGNALS_LOW_RISK_MIN_SCORE || 78),
    mediumRiskMinScore: Number(process.env.PUBLIC_SIGNALS_MEDIUM_RISK_MIN_SCORE || 60),
    mediumRiskMinPostingScore: Number(process.env.PUBLIC_SIGNALS_MEDIUM_RISK_MIN_POSTING_SCORE || 72),
    highRiskPostable: envFlag("PUBLIC_SIGNALS_HIGH_RISK_POSTABLE", false),
    mediumRiskPostable: envFlag("PUBLIC_SIGNALS_MEDIUM_RISK_POSTABLE", true),
    symbolCooldownMinutes: envObjectNumbers("PUBLIC_SIGNALS_SYMBOL_COOLDOWN_MINUTES", {
      EURUSD: 60,
      XAUUSD: 45,
      GBPUSD: 60,
      USDJPY: 60,
      AUDUSD: 60,
      USDCAD: 60,
      USDCHF: 60,
      XAGUSD: 45,
      'CL-OIL': 45,
    }),
  },
  dailySummary: {
    enabled: envFlag('DAILY_SUMMARY_ENABLED', true),
    hourLocal: Number(process.env.DAILY_SUMMARY_HOUR_LOCAL || 23),
    minuteLocal: Number(process.env.DAILY_SUMMARY_MINUTE_LOCAL || 55),
  },
  tradeManagement: {
    breakevenEnabled: envFlag("TRADE_BREAKEVEN_ENABLED", true),
    breakevenTriggerRiskMultiple: Number(process.env.TRADE_BREAKEVEN_TRIGGER_R || 1),
    breakevenBufferRiskMultiple: Number(process.env.TRADE_BREAKEVEN_BUFFER_R || 0.05),
    partialTakeProfitEnabled: envFlag("TRADE_PARTIAL_TP_ENABLED", true),
    partialTakeProfitTriggerRiskMultiple: Number(process.env.TRADE_PARTIAL_TP_TRIGGER_R || 1),
    partialTakeProfitClosePct: Number(process.env.TRADE_PARTIAL_TP_CLOSE_PCT || 0.5),
    trailingEnabled: envFlag("TRADE_TRAILING_ENABLED", true),
    trailingStartAfterPartial: envFlag("TRADE_TRAILING_START_AFTER_PARTIAL", true),
    trailingActivationRiskMultiple: Number(process.env.TRADE_TRAILING_TRIGGER_R || 1.5),
    trailingDistanceRiskMultiple: Number(process.env.TRADE_TRAILING_DISTANCE_R || 0.75),
    profitLockEnabled: envFlag("PROFIT_LOCK_ENABLED", true),
    activationRiskMultiple: Number(process.env.PROFIT_LOCK_ACTIVATION_R || 1),
    lockPct: Number(process.env.PROFIT_LOCK_PCT || 0.5),
    minStepRiskMultiple: Number(process.env.PROFIT_LOCK_MIN_STEP_R || 0.25),
  },
  safetyControls: {
    eurusdLossStreakTrigger: Number(process.env.EURUSD_LOSS_STREAK_TRIGGER || 2),
    eurusdLossStreakCooldownMinutes: Number(process.env.EURUSD_LOSS_STREAK_COOLDOWN_MINUTES || 20),
    eurusdSameSetupDebounceMinutes: Number(process.env.EURUSD_SAME_SETUP_DEBOUNCE_MINUTES || 5),
    eurusdRangingBiasApprovalCap: Number(process.env.EURUSD_RANGING_BIAS_APPROVAL_CAP || 58),
    eurusdRangingBiasDebounceMinutes: Number(process.env.EURUSD_RANGING_BIAS_DEBOUNCE_MINUTES || 15),
    eurusdRangingBiasLossCooldownMinutes: Number(process.env.EURUSD_RANGING_BIAS_LOSS_COOLDOWN_MINUTES || 12),
    eurusdRangingBiasZoneSize: Number(process.env.EURUSD_RANGING_BIAS_ZONE_SIZE || 0.001),
    eurusdFailedZoneCooldownMinutes: Number(process.env.EURUSD_FAILED_ZONE_COOLDOWN_MINUTES || process.env.EURUSD_RANGING_BIAS_LOSS_COOLDOWN_MINUTES || 12),
  },
  hybrid: {
    defaultMode: envUpper("HYBRID_DEFAULT_MODE", "HYBRID"),
    watchDecision: envUpper("HYBRID_WATCH_DECISION", "WATCH"),
    symbols: {
      EURUSD: buildSymbolSetting("EURUSD", {
        mode: "STRATEGY_WITH_SIGNAL_CONFLUENCE",
        primarySource: "STRATEGY",
        allowTelegramTrigger: false,
        requireTrendAlignment: true,
        requireStructuredSignal: true,
        requireTakeProfit: true,
        blockNearNews: true,
        useSignalConfluence: true,
        allowedSessions: ["LONDON", "NEWYORK"],
        minRiskReward: 1.4,
        minTp1RiskReward: 1.0,
        minFinalRiskReward: 1.4,
        maxSpreadPct: 0.00025,
        maxSignalAgeMinutes: 15,
        maxEntryDeviationPct: 0.001,
        minApproveScore: 60,
        minWatchScore: 45,
        riskPerTrade: 0.01,
        maxPositionSize: 10,
        maxDailyLossPct: 0.025,
        maxOpenTrades: 1,
      }),
      XAUUSD: buildSymbolSetting("XAUUSD", {
        mode: "HYBRID",
        primarySource: "STRATEGY",
        allowTelegramTrigger: true,
        requireTrendAlignment: true,
        requireStructuredSignal: true,
        requireTakeProfit: true,
        blockNearNews: true,
        useSignalConfluence: true,
        allowedSessions: ["LONDON", "NEWYORK"],
        minRiskReward: 1.5,
        minTp1RiskReward: 0.9,
        minFinalRiskReward: 1.5,
        maxSpreadPct: 0.0015,
        maxSignalAgeMinutes: 20,
        maxEntryDeviationPct: 0.0025,
        minApproveScore: 62,
        minWatchScore: 45,
        riskPerTrade: 0.0075,
        maxPositionSize: 5,
        maxDailyLossPct: 0.025,
        maxOpenTrades: 1,
      }),
    },
  },
  backtest: {
    barCount: Number(process.env.BACKTEST_BAR_COUNT || 1000),
    walkForwardWindowBars: Number(process.env.BACKTEST_WALKFORWARD_WINDOW_BARS || 250),
    walkForwardStepBars: Number(process.env.BACKTEST_WALKFORWARD_STEP_BARS || 125),
  },
};

config.getSymbolSettings = function getSymbolSettings(symbol) {
  const key = String(symbol || "").toUpperCase();
  return config.hybrid.symbols[key] || buildSymbolSetting(key, {
    mode: config.hybrid.defaultMode,
    primarySource: "STRATEGY",
    allowTelegramTrigger: true,
    requireTrendAlignment: true,
    requireStructuredSignal: true,
    requireTakeProfit: true,
    blockNearNews: true,
    useSignalConfluence: false,
    allowedSessions: ["LONDON", "NEWYORK"],
    minRiskReward: 1.3,
    minTp1RiskReward: 1.0,
    minFinalRiskReward: 1.3,
    maxSpreadPct: 0.0004,
    maxSignalAgeMinutes: 20,
    maxEntryDeviationPct: 0.002,
    minApproveScore: 60,
    minWatchScore: 45,
    riskPerTrade: config.risk.riskPerTrade,
    maxPositionSize: config.risk.maxPositionSize,
    maxDailyLossPct: config.risk.maxDailyLossPct,
    maxOpenTrades: 1,
  });
};

module.exports = applyDemoStressOverrides(config);
