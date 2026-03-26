function getHistoricalCloses() {
  return Array.from({ length: 100 }, () => 100 + Math.random() * 10);
}

function getLatestPrice() {
  return 100 + Math.random() * 10;
}

module.exports = { getHistoricalCloses, getLatestPrice };