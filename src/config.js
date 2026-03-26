const config = {
  intervalMs: 5000,
  strategy: {
    shortMa: 20,
    longMa: 50,
  },
  risk: {
    riskPerTrade: 0.01,
    maxPositionSize: 10,
  },
};

module.exports = config;
