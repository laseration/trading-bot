const config = require("./config");
const { getHistoricalBars } = require("./dataFeed");
const { generateSignal } = require("./strategy");
const { calculatePositionSize } = require("./risk");

const INITIAL_CASH = 10000;

function envBacktestValue(name) {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === "" ? undefined : raw;
}

function readBacktestOverrideNumber(name) {
  const raw = envBacktestValue(name);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBacktestOverrideList(name) {
  const raw = envBacktestValue(name);

  if (raw === undefined) {
    return undefined;
  }

  return String(raw)
    .split(/[,\n;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getBacktestStrategyOverrides() {
  return {
    name: envBacktestValue("BACKTEST_STRATEGY_NAME"),
    timeframe: envBacktestValue("BACKTEST_STRATEGY_TIMEFRAME"),
    confirmationTimeframes: readBacktestOverrideList("BACKTEST_STRATEGY_CONFIRMATION_TIMEFRAMES"),
    minConfirmations: readBacktestOverrideNumber("BACKTEST_STRATEGY_MIN_CONFIRMATIONS"),
    adxMin: readBacktestOverrideNumber("BACKTEST_STRATEGY_ADX_MIN"),
    minAtrPct: readBacktestOverrideNumber("BACKTEST_STRATEGY_MIN_ATR_PCT"),
    sessionStartHourUtc: readBacktestOverrideNumber("BACKTEST_STRATEGY_SESSION_START_HOUR_UTC"),
    sessionEndHourUtc: readBacktestOverrideNumber("BACKTEST_STRATEGY_SESSION_END_HOUR_UTC"),
    atrStopMultiplier: readBacktestOverrideNumber("BACKTEST_STRATEGY_ATR_STOP_MULTIPLIER"),
    atrTakeProfitMultiplier: readBacktestOverrideNumber("BACKTEST_STRATEGY_ATR_TAKE_PROFIT_MULTIPLIER"),
    shortMa: readBacktestOverrideNumber("BACKTEST_STRATEGY_SHORT_MA"),
    longMa: readBacktestOverrideNumber("BACKTEST_STRATEGY_LONG_MA"),
    breakoutLookback: readBacktestOverrideNumber("BACKTEST_STRATEGY_BREAKOUT_LOOKBACK"),
    meanReversionRsiBuyMax: readBacktestOverrideNumber("BACKTEST_STRATEGY_MEAN_REVERSION_RSI_BUY_MAX"),
    meanReversionRsiSellMin: readBacktestOverrideNumber("BACKTEST_STRATEGY_MEAN_REVERSION_RSI_SELL_MIN"),
  };
}

function cloneStrategyConfig() {
  return JSON.parse(JSON.stringify(config.strategy));
}

function applyStrategyOverrides(overrides = {}) {
  Object.entries(overrides).forEach(([key, value]) => {
    if (value !== undefined) {
      config.strategy[key] = value;
    }
  });
}

async function withStrategyOverrides(overrides = {}, work) {
  const snapshot = cloneStrategyConfig();

  try {
    applyStrategyOverrides(overrides);
    return await work();
  } finally {
    Object.keys(config.strategy).forEach((key) => {
      delete config.strategy[key];
    });
    Object.assign(config.strategy, snapshot);
  }
}

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function mean(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + Number(value || 0), 0) / values.length;
}

function standardDeviation(values = []) {
  if (!Array.isArray(values) || values.length < 2) {
    return 0;
  }

  const average = mean(values);
  const variance = values.reduce((total, value) => {
    const diff = Number(value || 0) - average;
    return total + diff * diff;
  }, 0) / (values.length - 1);

  return Math.sqrt(variance);
}

function calculateMaxDrawdown(equityCurve = []) {
  let peak = null;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    const equity = Number(point.equity || 0);

    if (!Number.isFinite(equity)) {
      continue;
    }

    if (peak == null || equity > peak) {
      peak = equity;
    }

    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }

  return maxDrawdown;
}

function calculateSharpeRatio(returns = []) {
  const usable = returns.filter((value) => Number.isFinite(value));
  const deviation = standardDeviation(usable);

  if (usable.length < 2 || deviation <= 0) {
    return 0;
  }

  return (mean(usable) / deviation) * Math.sqrt(252);
}

function calculateSortinoRatio(returns = []) {
  const usable = returns.filter((value) => Number.isFinite(value));
  const downside = usable.filter((value) => value < 0);
  const downsideDeviation = standardDeviation(downside);

  if (usable.length < 2 || downsideDeviation <= 0) {
    return 0;
  }

  return (mean(usable) / downsideDeviation) * Math.sqrt(252);
}

function buildPerformanceAttribution(trades = []) {
  const byDirection = {};
  const byMonth = {};

  for (const trade of trades) {
    const directionKey = String(trade.direction || "UNKNOWN").toUpperCase();
    const monthKey = String(trade.closedAt || trade.openedAt || "").slice(0, 7) || "UNKNOWN";

    if (!byDirection[directionKey]) {
      byDirection[directionKey] = { trades: 0, pnl: 0, wins: 0, losses: 0 };
    }

    byDirection[directionKey].trades += 1;
    byDirection[directionKey].pnl += Number(trade.pnl || 0);
    byDirection[directionKey].wins += trade.pnl > 0 ? 1 : 0;
    byDirection[directionKey].losses += trade.pnl < 0 ? 1 : 0;

    if (!byMonth[monthKey]) {
      byMonth[monthKey] = { trades: 0, pnl: 0, wins: 0, losses: 0 };
    }

    byMonth[monthKey].trades += 1;
    byMonth[monthKey].pnl += Number(trade.pnl || 0);
    byMonth[monthKey].wins += trade.pnl > 0 ? 1 : 0;
    byMonth[monthKey].losses += trade.pnl < 0 ? 1 : 0;
  }

  return { byDirection, byMonth };
}

async function getConfirmationBars(profile, baseBarsLength) {
  const confirmationBarsByTimeframe = {};

  for (const timeframe of config.strategy.confirmationTimeframes || []) {
    confirmationBarsByTimeframe[timeframe] = await getHistoricalBars(profile, {
      timeframe,
      count: Math.max(baseBarsLength, config.strategy.longMa + config.strategy.atrPeriod + 25),
    });
  }

  return confirmationBarsByTimeframe;
}

function buildConfirmationSlices(confirmationBarsByTimeframe, currentTimeMs) {
  const sliced = {};

  for (const [timeframe, bars] of Object.entries(confirmationBarsByTimeframe || {})) {
    const index = findCloseIndex(bars, Math.floor(currentTimeMs / 1000));

    if (index >= 0) {
      sliced[timeframe] = bars.slice(0, index + 1);
    }
  }

  return sliced;
}

function findCloseIndex(confirmationBars = [], currentTime) {
  let resolvedIndex = -1;

  for (let index = 0; index < confirmationBars.length; index += 1) {
    const barTime = Number(confirmationBars[index] && confirmationBars[index].time);

    if (Number.isFinite(barTime) && barTime <= currentTime) {
      resolvedIndex = index;
    } else {
      break;
    }
  }

  return resolvedIndex;
}

function buildSignalOptions(confirmationBarsByTimeframe, currentTimeMs, hasRecentRelevantNews = false) {
  return {
    strategyName: config.strategy.name,
    hasRecentRelevantNews,
    confirmationBarsByTimeframe: buildConfirmationSlices(confirmationBarsByTimeframe, currentTimeMs),
    currentTimeMs,
  };
}

function computeTradePnl(direction, entryPrice, exitPrice, qty) {
  const signedMove = String(direction || "").toUpperCase() === "SELL"
    ? Number(entryPrice) - Number(exitPrice)
    : Number(exitPrice) - Number(entryPrice);
  return signedMove * Number(qty || 0);
}

function calculateTradeMetrics(trades = [], initialCash = INITIAL_CASH, finalEquity = INITIAL_CASH, equityCurve = []) {
  const realizedPnl = trades.reduce((total, trade) => total + Number(trade.pnl || 0), 0);
  const wins = trades.filter((trade) => Number(trade.pnl) > 0);
  const losses = trades.filter((trade) => Number(trade.pnl) < 0);
  const grossProfit = wins.reduce((total, trade) => total + Number(trade.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((total, trade) => total + Number(trade.pnl || 0), 0));
  const equityReturns = equityCurve.slice(1).map((point, index) => {
    const previous = Number(equityCurve[index] && equityCurve[index].equity);
    const current = Number(point && point.equity);
    return previous > 0 ? (current - previous) / previous : 0;
  });

  return {
    tradeCount: trades.length,
    winRate: trades.length > 0 ? round((wins.length / trades.length) * 100, 1) : 0,
    realizedPnl: round(realizedPnl),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    averageTrade: trades.length > 0 ? round(realizedPnl / trades.length) : 0,
    averageWinner: wins.length > 0 ? round(grossProfit / wins.length) : 0,
    averageLoser: losses.length > 0 ? round(losses.reduce((total, trade) => total + Number(trade.pnl || 0), 0) / losses.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : grossProfit > 0 ? 999 : 0,
    totalReturnPct: initialCash > 0 ? round(((finalEquity - initialCash) / initialCash) * 100, 2) : 0,
    maxDrawdownPct: round(calculateMaxDrawdown(equityCurve) * 100, 2),
    sharpeRatio: round(calculateSharpeRatio(equityReturns), 2),
    sortinoRatio: round(calculateSortinoRatio(equityReturns), 2),
  };
}

async function runBacktest(profile = { symbol: "EURUSD", dataSource: "mock", signalSource: "strategy", broker: "paper" }, options = {}) {
  const initialCash = Number(options.initialCash || INITIAL_CASH);
  const strategyName = options.strategyName || config.strategy.name;
  const strategyOverrides = {
    ...getBacktestStrategyOverrides(),
    ...(options.strategyOverrides || {}),
    name: strategyName,
  };

  return withStrategyOverrides(strategyOverrides, async () => {
    const barCount = Math.max(
      Number(options.barCount || config.backtest.barCount || config.strategy.lookbackBars),
      config.strategy.lookbackBars,
      config.strategy.longMa + config.strategy.atrPeriod + 25,
    );
    const bars = await getHistoricalBars(profile, { count: barCount, timeframe: config.strategy.timeframe });
    const confirmationBarsByTimeframe = await getConfirmationBars(profile, barCount);
    let cash = initialCash;
    let position = null;
    let realizedPnl = 0;
    const trades = [];
    const equityCurve = [];
    const startIndex = Math.max(config.strategy.longMa, config.strategy.atrPeriod, config.strategy.breakoutLookback || 20, config.strategy.bollingerPeriod || 20);

    for (let index = startIndex; index < bars.length; index += 1) {
      const window = bars.slice(0, index + 1);
      const latestBar = window[window.length - 1];
      const price = Number(latestBar.close);
      const signalOptions = buildSignalOptions(confirmationBarsByTimeframe, Number(latestBar.time) * 1000, false);
      const setup = generateSignal(window, signalOptions);
      const signal = String((setup && setup.signal) || "HOLD").toUpperCase();

      if (position && ((position.direction === "BUY" && signal === "SELL") || (position.direction === "SELL" && signal === "BUY"))) {
        const pnl = computeTradePnl(position.direction, position.entryPrice, price, position.qty);
        cash += pnl;
        realizedPnl += pnl;
        trades.push({
          symbol: profile.symbol,
          strategyName,
          timeframe: config.strategy.timeframe,
          direction: position.direction,
          qty: position.qty,
          entryPrice: position.entryPrice,
          exitPrice: price,
          pnl: round(pnl),
          openedAt: position.openedAt,
          closedAt: new Date(Number(latestBar.time) * 1000).toISOString(),
        });
        position = null;
      }

      if (!position && (signal === "BUY" || signal === "SELL")) {
        const qty = calculatePositionSize(cash, price, {
          symbol: profile.symbol,
          stopLoss: setup && setup.stopLoss,
          stopDistance: setup && setup.stopDistance,
        });

        if (qty > 0) {
          position = {
            direction: signal,
            qty,
            entryPrice: price,
            openedAt: new Date(Number(latestBar.time) * 1000).toISOString(),
          };
        }
      }

      const unrealizedPnl = position ? computeTradePnl(position.direction, position.entryPrice, price, position.qty) : 0;
      equityCurve.push({
        time: Number(latestBar.time),
        equity: round(cash + unrealizedPnl),
      });
    }

    if (position) {
      const lastBar = bars[bars.length - 1];
      const exitPrice = Number(lastBar.close);
      const pnl = computeTradePnl(position.direction, position.entryPrice, exitPrice, position.qty);
      cash += pnl;
      realizedPnl += pnl;
      trades.push({
        symbol: profile.symbol,
        strategyName,
        timeframe: config.strategy.timeframe,
        direction: position.direction,
        qty: position.qty,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl: round(pnl),
        openedAt: position.openedAt,
        closedAt: new Date(Number(lastBar.time) * 1000).toISOString(),
      });
    }

    const finalEquity = round(cash);
    const metrics = calculateTradeMetrics(trades, initialCash, finalEquity, equityCurve);
    const attribution = buildPerformanceAttribution(trades);

    if (options.printSummary !== false) {
      console.log(`Backtest complete: ${profile.symbol} ${strategyName}`);
      console.log(`Bars: ${bars.length}`);
      console.log(`Trades: ${metrics.tradeCount}`);
      console.log(`Win rate: ${metrics.winRate}%`);
      console.log(`Realized PnL: ${metrics.realizedPnl.toFixed(2)}`);
      console.log(`Final equity: ${finalEquity.toFixed(2)}`);
      console.log(`Max drawdown: ${metrics.maxDrawdownPct.toFixed(2)}%`);
      console.log(`Sharpe: ${metrics.sharpeRatio.toFixed(2)} | Sortino: ${metrics.sortinoRatio.toFixed(2)}`);
    }

    return {
      symbol: profile.symbol,
      strategyName,
      timeframe: config.strategy.timeframe,
      bars: bars.length,
      trades,
      attribution,
      equityCurve,
      realizedPnl: round(realizedPnl),
      finalEquity,
      metrics,
      strategyConfig: cloneStrategyConfig(),
    };
  });
}

async function runWalkForward(profile = { symbol: "EURUSD", dataSource: "mock", signalSource: "strategy", broker: "paper" }, options = {}) {
  const strategyName = options.strategyName || config.strategy.name;
  const strategyOverrides = {
    ...getBacktestStrategyOverrides(),
    ...(options.strategyOverrides || {}),
    name: strategyName,
  };

  return withStrategyOverrides(strategyOverrides, async () => {
    const barCount = Math.max(
      Number(options.barCount || config.backtest.barCount || config.strategy.lookbackBars),
      config.strategy.lookbackBars,
      config.strategy.longMa + config.strategy.atrPeriod + 25,
    );
    const windowBars = Math.max(
      Number(options.windowBars || config.backtest.walkForwardWindowBars || 250),
      config.strategy.lookbackBars,
      config.strategy.longMa + config.strategy.atrPeriod + 25,
    );
    const stepBars = Math.max(1, Number(options.stepBars || config.backtest.walkForwardStepBars || 125));
    const bars = await getHistoricalBars(profile, { count: barCount, timeframe: config.strategy.timeframe });
    const confirmationBarsByTimeframe = await getConfirmationBars(profile, barCount);
    const windows = [];

    for (let endIndex = windowBars - 1; endIndex < bars.length; endIndex += stepBars) {
      const startIndex = endIndex - windowBars + 1;
      const window = bars.slice(startIndex, endIndex + 1);
      const latestBar = window[window.length - 1];
      const setup = generateSignal(window, {
        strategyName,
        hasRecentRelevantNews: false,
        confirmationBarsByTimeframe: buildConfirmationSlices(
          confirmationBarsByTimeframe,
          Number(latestBar.time) * 1000,
        ),
        currentTimeMs: Number(latestBar.time) * 1000,
      });

      windows.push({
        startTime: new Date(Number(window[0].time) * 1000).toISOString(),
        endTime: new Date(Number(latestBar.time) * 1000).toISOString(),
        signal: setup.signal,
        reasons: setup.reasons || [],
        strategyName,
        timeframe: config.strategy.timeframe,
        confidenceLabel: setup.confidenceLabel || "",
      });
    }

    const signalCounts = windows.reduce((totals, window) => {
      const key = String(window.signal || "HOLD").toUpperCase();
      totals[key] = (totals[key] || 0) + 1;
      return totals;
    }, {});

    return {
      symbol: profile.symbol,
      strategyName,
      timeframe: config.strategy.timeframe,
      totalWindows: windows.length,
      signalCounts,
      windows,
    };
  });
}

async function compareStrategies(profile, strategyNames = ["trend", "breakout", "mean_reversion"], options = {}) {
  const results = [];

  for (const strategyName of strategyNames) {
    const result = await runBacktest(profile, {
      ...options,
      strategyName,
      printSummary: false,
    });
    results.push(result);
  }

  const ranked = [...results].sort((left, right) => {
    if (right.metrics.totalReturnPct !== left.metrics.totalReturnPct) {
      return right.metrics.totalReturnPct - left.metrics.totalReturnPct;
    }

    if (left.metrics.maxDrawdownPct !== right.metrics.maxDrawdownPct) {
      return left.metrics.maxDrawdownPct - right.metrics.maxDrawdownPct;
    }

    return right.metrics.sharpeRatio - left.metrics.sharpeRatio;
  });

  return {
    symbol: profile.symbol,
    ranked,
    winner: ranked[0] || null,
  };
}

if (require.main === module) {
  runBacktest().catch((err) => {
    console.error(`Backtest failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  compareStrategies,
  runBacktest,
  runWalkForward,
  withStrategyOverrides,
};
