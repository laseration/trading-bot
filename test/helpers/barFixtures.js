function buildBar(index, close, options = {}) {
  const time = Math.floor((options.startTimeMs || Date.UTC(2026, 0, 1, 12, 0, 0)) / 1000)
    + index * Number(options.stepSeconds || 900);
  const open = Number.isFinite(Number(options.open)) ? Number(options.open) : close;
  const range = Number(options.range || 0.0004);

  return {
    time,
    open,
    high: Math.max(open, close) + range,
    low: Math.min(open, close) - range,
    close,
    volume: options.volume ?? 1000,
  };
}

function flatBars(count = 80, options = {}) {
  const price = Number(options.price || 1.1);

  return Array.from({ length: count }, (_, index) => buildBar(index, price, options));
}

function trendingBars(count = 80, options = {}) {
  const direction = String(options.direction || "up").toLowerCase();
  const start = Number(options.start || 1.1);
  const step = Number(options.step || 0.00045) * (direction === "down" ? -1 : 1);

  return Array.from({ length: count }, (_, index) => {
    const previousClose = start + Math.max(0, index - 1) * step;
    const close = start + index * step;
    return buildBar(index, Number(close.toFixed(5)), {
      ...options,
      open: Number(previousClose.toFixed(5)),
      range: options.range ?? 0.0002,
    });
  });
}

function breakoutBars(count = 80, options = {}) {
  const bars = trendingBars(count, options);
  const last = bars[bars.length - 1];
  const breakoutMove = Number(options.breakoutMove || 0.003);
  const close = Number((last.close + breakoutMove).toFixed(5));

  bars[bars.length - 1] = {
    ...last,
    open: Number((last.close - breakoutMove / 2).toFixed(5)),
    high: Number((close + 0.0003).toFixed(5)),
    low: Number((last.low - 0.0001).toFixed(5)),
    close,
  };

  return bars;
}

function unstableHighVolBars(count = 80, options = {}) {
  const start = Number(options.start || 1.1);

  return Array.from({ length: count }, (_, index) => {
    const direction = index % 2 === 0 ? 1 : -1;
    const close = Number((start + direction * (0.003 + index * 0.00002)).toFixed(5));
    return buildBar(index, close, {
      ...options,
      open: Number((start - direction * 0.0015).toFixed(5)),
      range: options.range ?? 0.0015,
    });
  });
}

module.exports = {
  breakoutBars,
  flatBars,
  trendingBars,
  unstableHighVolBars,
};
