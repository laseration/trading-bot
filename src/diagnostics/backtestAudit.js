function buildBacktestAudit(config, env = process.env) {
  const profile = {
    symbol: env.BACKTEST_SYMBOL || "EURUSD",
    source: env.BACKTEST_SOURCE || "mock",
    broker: "paper",
    signalSource: "strategy",
  };
  const strategyName = env.BACKTEST_STRATEGY || env.BACKTEST_STRATEGY_NAME || config.strategy.name;
  const warnings = [
    {
      code: "source_mock",
      message: profile.source === "mock"
        ? "Backtest source is mock; generated bars are useful for smoke checks, not market-realistic performance claims."
        : `Backtest source is ${profile.source}; verify the feed includes production-quality historical bid/ask data before treating results as realistic.`,
    },
    {
      code: "no_cost_model",
      message: "PnL is computed from close-to-close price movement only; spread, slippage, swap, and commission are not modelled.",
    },
    {
      code: "flip_or_terminal_exits",
      message: "Positions close on an opposite signal or at end of run; the path does not model broker fills between signals.",
    },
    {
      code: "no_intrabar_sltp",
      message: "Stop-loss and take-profit distances are used for sizing, but intrabar SL/TP hits and execution prices are not simulated.",
    },
    {
      code: "no_news_session_realism",
      message: "The backtest path passes hasRecentRelevantNews=false and does not model live news, spread, liquidity, or session execution constraints.",
    },
    {
      code: "walkforward_signal_windows",
      message: "Walk-forward analysis inspects signal windows; it is not a true out-of-sample execution validation with rolling portfolio state.",
    },
  ];

  return {
    profile,
    strategyName,
    timeframe: config.strategy.timeframe,
    barCount: config.backtest.barCount,
    walkForwardWindowBars: config.backtest.walkForwardWindowBars,
    walkForwardStepBars: config.backtest.walkForwardStepBars,
    warnings,
  };
}

module.exports = {
  buildBacktestAudit,
};
