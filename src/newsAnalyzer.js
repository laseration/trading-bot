const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { SentimentAnalyzer, PorterStemmer, WordTokenizer } = require('natural');
const config = require('./config');
const { getLatestPrice } = require('./dataFeed');
const { log } = require('./logger');
const { classifyRiskLevel } = require('./signals/assessRiskLevel');

const analyzer = new SentimentAnalyzer('English', PorterStemmer, 'afinn');
const tokenizer = new WordTokenizer();
const STATE_PATH = path.join(__dirname, '..', 'logs', 'news-state.json');
const STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let newsFetchCache = {
  fetchedAt: 0,
  articles: [],
};

const ENTITY_TERMS = {
  USD: ['usd', 'dollar', 'federal reserve', 'fed', 'treasury', 'us economy', 'u.s. economy', 'powell', 'fomc'],
  EUR: ['eur', 'euro', 'ecb', 'eurozone', 'lagarde', 'european central bank'],
  GBP: ['gbp', 'pound', 'sterling', 'boe', 'bank of england', 'bailey', 'uk economy', 'british economy'],
  JPY: ['jpy', 'yen', 'boj', 'bank of japan', 'ueda', 'japanese economy', 'japan'],
  AUD: ['aud', 'aussie', 'rba', 'reserve bank of australia', 'australian economy', 'australia'],
  CAD: ['cad', 'loonie', 'boc', 'bank of canada', 'canadian economy', 'canada'],
  CHF: ['chf', 'franc', 'snb', 'swiss national bank', 'swiss economy', 'switzerland'],
  XAU: ['xau', 'gold', 'bullion', 'precious metal'],
  XAG: ['xag', 'silver', 'bullion', 'precious metal'],
  OIL: ['oil', 'crude', 'wti', 'brent', 'opec', 'barrel', 'energy market'],
};

const SYMBOL_RULES = {
  EURUSD: { base: 'EUR', quote: 'USD' },
  GBPUSD: { base: 'GBP', quote: 'USD' },
  USDJPY: { base: 'USD', quote: 'JPY' },
  AUDUSD: { base: 'AUD', quote: 'USD' },
  USDCAD: { base: 'USD', quote: 'CAD' },
  USDCHF: { base: 'USD', quote: 'CHF' },
  XAUUSD: { base: 'XAU', quote: 'USD', safeHaven: true },
  XAGUSD: { base: 'XAG', quote: 'USD', safeHaven: true },
  'CL-OIL': { base: 'OIL', quote: 'USD', commodityMomentum: true },
};

const POSITIVE_PATTERNS = [
  { pattern: /\b(rate hike|raises rates|raised rates|hawkish|upbeat outlook|beats expectations|beat expectations|strong payrolls|growth accelerates|inflation rises|hot inflation|higher yields|surges|rallies|rebound)\b/i, weight: 1.2 },
  { pattern: /\b(expands|improves|strengthens|bullish|optimistic|upgrade|upgraded|record high|strong demand)\b/i, weight: 0.8 },
];

const NEGATIVE_PATTERNS = [
  { pattern: /\b(rate cut|cuts rates|cut rates|dovish|misses expectations|missed expectations|weak payrolls|growth slows|recession|inflation cools|lower yields|slides|selloff|risk-off)\b/i, weight: -1.2 },
  { pattern: /\b(contracts|weakens|bearish|pessimistic|downgrade|downgraded|geopolitical tension|crisis|slowdown)\b/i, weight: -0.8 },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
}

function readState() {
  ensureStateDir();

  if (!fs.existsSync(STATE_PATH)) {
    return { seenSignals: {} };
  }

  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8').trim();
    return raw ? JSON.parse(raw) : { seenSignals: {} };
  } catch (err) {
    return { seenSignals: {} };
  }
}

function writeState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function pruneState(state) {
  const cutoff = Date.now() - STATE_RETENTION_MS;

  for (const [key, seenAt] of Object.entries(state.seenSignals || {})) {
    if (Date.parse(seenAt) < cutoff) {
      delete state.seenSignals[key];
    }
  }
}

function buildExecutionProfileMap(profilesBySymbol) {
  if (profilesBySymbol instanceof Map) {
    return profilesBySymbol;
  }

  return new Map(
    (config.profiles || [])
      .filter((profile) => profile && profile.symbol)
      .map((profile) => [String(profile.symbol).toUpperCase(), profile]),
  );
}

function normalizeArticle(article = {}) {
  return {
    provider: article.provider || article.source || 'news',
    id: String(article.id || article.url || `${article.title || 'headline'}-${article.publishedAt || Date.now()}`),
    title: String(article.title || '').trim(),
    description: String(article.description || article.summary || '').trim(),
    content: String(article.content || '').trim(),
    url: String(article.url || '').trim(),
    publishedAt: toIsoString(article.publishedAt || article.time_published || Date.now()),
  };
}

function dedupeArticles(articles = []) {
  const seen = new Set();
  const deduped = [];

  for (const article of articles) {
    const normalized = normalizeArticle(article);
    const key = `${normalized.provider}|${normalized.id}`;

    if (!normalized.title || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function fetchNewsApiArticles() {
  if (!config.news.apiKey) {
    return [];
  }

  const response = await axios.get(`${String(config.news.baseUrl || '').replace(/\/+$/, '')}/everything`, {
    params: {
      apiKey: config.news.apiKey,
      q: config.news.searchQuery,
      language: 'en',
      sortBy: 'publishedAt',
      from: isoMinutesAgo(config.news.lookbackMinutes),
      pageSize: config.news.maxArticlesPerPoll,
    },
    timeout: 15000,
  });

  return (response.data.articles || []).map((article) => ({
    provider: 'NewsAPI',
    id: article.url || article.title,
    title: article.title,
    description: article.description,
    content: article.content,
    url: article.url,
    publishedAt: article.publishedAt,
  }));
}

async function fetchAlphaVantageArticles() {
  if (!config.news.alphaVantageApiKey) {
    return [];
  }

  const response = await axios.get(config.news.alphaVantageBaseUrl, {
    params: {
      function: 'NEWS_SENTIMENT',
      topics: 'forex,financial_markets,commodities',
      limit: config.news.maxArticlesPerPoll,
      apikey: config.news.alphaVantageApiKey,
    },
    timeout: 15000,
  });

  return (response.data.feed || []).map((article) => ({
    provider: 'AlphaVantage',
    id: article.url || article.title,
    title: article.title,
    description: article.summary,
    content: article.summary,
    url: article.url,
    publishedAt: article.time_published,
  }));
}

async function fetchConfiguredNews() {
  const cacheAgeMs = Date.now() - Number(newsFetchCache.fetchedAt || 0);

  if (
    Array.isArray(newsFetchCache.articles)
    && newsFetchCache.articles.length > 0
    && cacheAgeMs >= 0
    && cacheAgeMs < Number(config.news.fetchCacheMs || 0)
  ) {
    return newsFetchCache.articles;
  }

  const providerResults = await Promise.allSettled([
    fetchNewsApiArticles(),
    fetchAlphaVantageArticles(),
  ]);

  const articles = [];

  providerResults.forEach((result) => {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
      return;
    }

    log(`[NEWS] Provider fetch failed: ${result.reason.message}`);
  });

  const deduped = dedupeArticles(articles);
  newsFetchCache = {
    fetchedAt: Date.now(),
    articles: deduped,
  };
  return deduped;
}

function isMajorSymbolNews(article, symbol) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const text = `${article.title} ${article.description} ${article.content}`.toLowerCase();

  if (normalizedSymbol === 'EURUSD') {
    return /\b(ecb|eurozone|lagarde|federal reserve|fed|fomc|powell|inflation|cpi|payrolls|nfp|rates)\b/.test(text);
  }

  if (normalizedSymbol === 'XAUUSD') {
    return /\b(gold|bullion|fed|inflation|rates|geopolitical|war|safe haven)\b/.test(text);
  }

  return false;
}

function isHighImpactCooldownNews(article, symbol) {
  const normalizedSymbol = String(symbol || '').toUpperCase();

  if (normalizedSymbol === 'EURUSD') {
    // Use headline/summary only for cooldown blocking so generic article body
    // mentions do not suppress normal EURUSD trading for long stretches.
    const headlineText = `${article.title} ${article.description}`.toLowerCase();
    return /\b(ecb|fomc|federal reserve|powell|lagarde|nfp|nonfarm payrolls|payrolls|cpi|interest rate decision|rate decision|inflation report)\b/.test(headlineText);
  }

  return isMajorSymbolNews(article, symbol);
}

async function hasRecentRelevantNews(symbol, cooldownMinutes = config.strategy.newsCooldownMinutes) {
  if (cooldownMinutes <= 0) {
    return false;
  }

  const articles = await fetchConfiguredNews();
  const cutoff = Date.now() - cooldownMinutes * 60 * 1000;

  return articles.some((article) => {
    const publishedAt = Date.parse(article.publishedAt || 0);
    return Number.isFinite(publishedAt) && publishedAt >= cutoff && isHighImpactCooldownNews(article, symbol);
  });
}

function countKeywordHits(text, keywords = []) {
  const lowerText = String(text || '').toLowerCase();
  let hits = 0;

  for (const keyword of keywords) {
    if (lowerText.includes(String(keyword).toLowerCase())) {
      hits += 1;
    }
  }

  return hits;
}

function scoreLexicon(text) {
  let score = 0;

  for (const entry of POSITIVE_PATTERNS) {
    if (entry.pattern.test(text)) {
      score += entry.weight;
    }
  }

  for (const entry of NEGATIVE_PATTERNS) {
    if (entry.pattern.test(text)) {
      score += entry.weight;
    }
  }

  return score;
}

function analyzeSentiment(text) {
  const tokens = tokenizer.tokenize(String(text || '').toLowerCase());
  const naturalScore = tokens.length > 0 ? analyzer.getSentiment(tokens) : 0;
  const combinedScore = clamp(naturalScore / 4 + scoreLexicon(text), -3, 3);
  const confidence = clamp(Math.abs(combinedScore) / 1.8, 0, 1);
  const label = combinedScore > 0.2 ? 'positive' : combinedScore < -0.2 ? 'negative' : 'neutral';

  return {
    score: Number(combinedScore.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    label,
  };
}

function calculateRelevance(text, title, rule) {
  const titleText = String(title || '').toLowerCase();
  const bodyText = String(text || '').toLowerCase();
  const baseTerms = ENTITY_TERMS[rule.base] || [];
  const quoteTerms = ENTITY_TERMS[rule.quote] || [];
  const baseHits = countKeywordHits(bodyText, baseTerms);
  const quoteHits = countKeywordHits(bodyText, quoteTerms);
  const titleHits = countKeywordHits(titleText, [...baseTerms, ...quoteTerms]);
  const rawScore = titleHits * 0.45 + (baseHits + quoteHits) * 0.18;

  return {
    baseHits,
    quoteHits,
    relevanceScore: Number(clamp(rawScore, 0, 1).toFixed(3)),
  };
}

function derivePairBias(symbol, article, sentiment) {
  const rule = SYMBOL_RULES[String(symbol || '').toUpperCase()];

  if (!rule) {
    return null;
  }

  const fullText = `${article.title} ${article.description} ${article.content}`.trim();
  const relevance = calculateRelevance(fullText, article.title, rule);

  if (relevance.relevanceScore < config.news.relevanceThreshold) {
    return null;
  }

  const baseMultiplier = relevance.baseHits > 0 ? relevance.baseHits : 0;
  const quoteMultiplier = relevance.quoteHits > 0 ? relevance.quoteHits : 0;
  let directionalScore = sentiment.score * baseMultiplier - sentiment.score * quoteMultiplier;

  if (rule.safeHaven && /risk-off|geopolitical|safe haven|tariff|war|conflict/i.test(fullText)) {
    directionalScore += 0.8;
  }

  if (rule.commodityMomentum && /supply disruption|production cut|opec|inventory draw|pipeline|refinery|middle east|strait of hormuz|sanction/i.test(fullText)) {
    directionalScore += sentiment.label === 'positive' ? 0.9 : -0.9;
  }

  if (Math.abs(directionalScore) < 0.2) {
    return null;
  }

  const side = directionalScore > 0 ? 'BUY' : 'SELL';
  const confidence = clamp(
    Math.abs(directionalScore) * 0.28 + relevance.relevanceScore * 0.42 + sentiment.confidence * 0.3,
    0,
    1,
  );

  if (confidence < config.news.sentimentThreshold) {
    return null;
  }

  return {
    side,
    confidence: Number(confidence.toFixed(3)),
    relevanceScore: relevance.relevanceScore,
    baseHits: relevance.baseHits,
    quoteHits: relevance.quoteHits,
    directionalScore: Number(directionalScore.toFixed(3)),
  };
}

function buildTargets(entry, side) {
  const riskDistance = entry * config.news.stopLossPct;
  const signed = side === 'BUY' ? 1 : -1;
  const stopLoss = entry - signed * riskDistance;
  const takeProfits = [
    entry + signed * riskDistance * 1.5,
    entry + signed * riskDistance * config.news.rewardRiskRatio,
    entry + signed * riskDistance * (config.news.rewardRiskRatio + 0.5),
  ];

  return {
    stopLoss: Number(stopLoss.toFixed(entry >= 1 ? 5 : 6)),
    takeProfits: takeProfits.map((value) => Number(value.toFixed(entry >= 1 ? 5 : 6))),
  };
}

function isAllowedRiskLevel(level) {
  return config.news.allowedRiskLevels.includes(String(level || '').toUpperCase());
}

function buildSignalId(articleId, symbol) {
  return `news-${String(articleId).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80)}-${symbol}`;
}

async function generateSignalFromArticle(article, symbol, profile) {
  const sentiment = analyzeSentiment(`${article.title} ${article.description} ${article.content}`.trim());

  if (sentiment.label === 'neutral') {
    return null;
  }

  const pairBias = derivePairBias(symbol, article, sentiment);

  if (!pairBias) {
    return null;
  }

  const entry = await getLatestPrice(profile);
  const targets = buildTargets(entry, pairBias.side);
  const signal = {
    id: buildSignalId(article.id, symbol),
    eventType: 'signal',
    symbol,
    side: pairBias.side,
    direction: pairBias.side,
    entry,
    stopLoss: targets.stopLoss,
    takeProfits: targets.takeProfits,
    timeframe: 'H1',
    qty: null,
    timestamp: article.publishedAt,
    rawText: `${article.title}\n${article.description}`.trim(),
    source: 'news',
    chatId: 'news-feed',
    chatTitle: article.provider,
    sourceChatId: article.provider,
    sourceChatTitle: article.provider,
    sourceLabel: `News-based: ${article.title.slice(0, 90)}`,
    confidenceLabel: `News NLP ${(pairBias.confidence * 100).toFixed(0)}%`,
    headline: article.title,
    newsAnalysis: {
      provider: article.provider,
      url: article.url,
      sentiment,
      pairBias,
    },
  };
  const risk = classifyRiskLevel(signal);

  if (!isAllowedRiskLevel(risk.level)) {
    log(`[NEWS] Skipping ${symbol} from "${article.title}" because risk level is ${risk.level}`);
    return null;
  }

  signal.riskLevel = risk.level;
  signal.riskScore = risk.score;
  return signal;
}

async function analyzeArticlesToSignals(articles, options = {}) {
  const profilesBySymbol = buildExecutionProfileMap(options.profilesBySymbol);
  const persistedState = options.persistState === false ? { seenSignals: {} } : readState();
  pruneState(persistedState);
  const signals = [];

  for (const article of dedupeArticles(articles)) {
    for (const symbol of config.news.symbols) {
      const profile = profilesBySymbol.get(symbol);

      if (!profile || !SYMBOL_RULES[symbol]) {
        continue;
      }

      const signalKey = `${article.id}|${symbol}`;

      if (persistedState.seenSignals[signalKey]) {
        continue;
      }

      const signal = await generateSignalFromArticle(article, symbol, profile);

      if (!signal) {
        continue;
      }

      persistedState.seenSignals[signalKey] = new Date().toISOString();
      signals.push(signal);

      if (signals.length >= config.news.maxSignalsPerPoll) {
        break;
      }
    }

    if (signals.length >= config.news.maxSignalsPerPoll) {
      break;
    }
  }

  if (options.persistState !== false) {
    writeState(persistedState);
  }

  return signals;
}

async function pollNewsSignals(options = {}) {
  if (!config.news.enabled) {
    return [];
  }

  if (!config.news.apiKey && !config.news.alphaVantageApiKey) {
    log('[NEWS] News trading enabled but no NEWS_API_KEY or ALPHA_VANTAGE_API_KEY is configured');
    return [];
  }

  const articles = await fetchConfiguredNews();
  const signals = await analyzeArticlesToSignals(articles, options);

  if (signals.length > 0) {
    log(`[NEWS] Generated ${signals.length} news-driven signal(s)`);
  }

  return signals;
}

function loadBacktestArticles(filePath = config.news.backtestFile) {
  const resolvedPath = path.resolve(filePath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.articles || [];
}

async function runNewsBacktest(options = {}) {
  const articles = options.articles || loadBacktestArticles(options.filePath);
  const signals = await analyzeArticlesToSignals(articles, {
    profilesBySymbol: options.profilesBySymbol,
    persistState: false,
  });

  const summary = signals.reduce((accumulator, signal) => {
    accumulator.totalSignals += 1;
    accumulator.bySymbol[signal.symbol] = (accumulator.bySymbol[signal.symbol] || 0) + 1;
    accumulator.bySide[signal.direction] = (accumulator.bySide[signal.direction] || 0) + 1;
    return accumulator;
  }, {
    totalSignals: 0,
    bySymbol: {},
    bySide: {},
  });

  return {
    articleCount: articles.length,
    signals,
    summary,
  };
}

module.exports = {
  analyzeArticlesToSignals,
  analyzeSentiment,
  fetchConfiguredNews,
  hasRecentRelevantNews,
  loadBacktestArticles,
  pollNewsSignals,
  runNewsBacktest,
};
