const fs = require('fs');
const path = require('path');
const config = require('./config');

const logsDir = path.join(__dirname, '..', 'logs');
const updateOffsetPath = path.join(logsDir, 'telegram-offset.txt');
const signalMemoryPath = path.join(logsDir, 'telegram-signal-memory.json');

function ensureLogsDir() {
  fs.mkdirSync(logsDir, { recursive: true });
}

function loadUpdateOffset() {
  if (!fs.existsSync(updateOffsetPath)) {
    return 0;
  }

  const rawValue = fs.readFileSync(updateOffsetPath, 'utf8').trim();
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function saveUpdateOffset(offset) {
  ensureLogsDir();
  fs.writeFileSync(updateOffsetPath, String(offset));
}

function loadSignalMemory() {
  ensureLogsDir();

  if (!fs.existsSync(signalMemoryPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(signalMemoryPath, 'utf8').trim();
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveSignalMemory(memory) {
  ensureLogsDir();
  fs.writeFileSync(signalMemoryPath, JSON.stringify(memory, null, 2));
}

let updateOffset = loadUpdateOffset();
let recentSignalMemory = loadSignalMemory();

const SYMBOL_ALIASES = {
  XAUUSD: ['GOLD', 'XAU', 'XAU/USD'],
  EURUSD: ['EUR/USD', 'EU'],
  GBPUSD: ['GBP/USD', 'GU'],
  USDJPY: ['USD/JPY', 'UJ'],
};

function normalizeSymbol(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeTextForSimilarity(text) {
  return String(text || '')
    .replace(/\[SOURCE\][^\n\r]*/gi, ' ')
    .replace(/\bSOURCE\b[^\n\r]*/gi, ' ')
    .replace(/[^A-Z0-9. ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function tokenizeText(text) {
  return Array.from(new Set(
    normalizeTextForSimilarity(text)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !/^\d+(?:\.\d+)?$/.test(token)),
  ));
}

function computeTokenOverlap(leftTokens, rightTokens) {
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let shared = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      shared += 1;
    }
  }

  const denominator = leftSet.size + rightSet.size - shared;
  return denominator > 0 ? shared / denominator : 0;
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function arePricesSimilar(left, right) {
  const leftNumber = parseNumber(left);
  const rightNumber = parseNumber(right);

  if (!(Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber > 0 && rightNumber > 0)) {
    return false;
  }

  return Math.abs(leftNumber - rightNumber) / Math.max(leftNumber, rightNumber) <= config.telegram.similarityPriceTolerancePct;
}

function buildSignalMemoryRecord(event) {
  return {
    id: event.id,
    symbol: event.symbol,
    direction: event.direction,
    entry: event.entry,
    stopLoss: event.stopLoss,
    takeProfits: Array.isArray(event.takeProfits) ? event.takeProfits : [],
    sourceLabel: event.sourceLabel || event.sourceChatTitle || '',
    sourceChatId: event.sourceChatId || '',
    rawText: event.rawText || '',
    tokenizedText: tokenizeText(event.rawText),
    timestamp: event.timestamp,
  };
}

function pruneSignalMemory() {
  const cutoff = Date.now() - config.telegram.similarityWindowMinutes * 60 * 1000;
  recentSignalMemory = recentSignalMemory.filter((record) => {
    const timestamp = Date.parse(record.timestamp || 0);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
  saveSignalMemory(recentSignalMemory);
}

function scoreSimilarity(event, candidate) {
  let score = 0;

  if (normalizeSymbol(event.symbol) === normalizeSymbol(candidate.symbol)) {
    score += 1.2;
  }

  if (String(event.direction || '').toUpperCase() === String(candidate.direction || '').toUpperCase()) {
    score += 0.8;
  }

  if (arePricesSimilar(event.entry, candidate.entry)) {
    score += 0.8;
  }

  if (arePricesSimilar(event.stopLoss, candidate.stopLoss)) {
    score += 0.5;
  }

  const leftTps = Array.isArray(event.takeProfits) ? event.takeProfits : [];
  const rightTps = Array.isArray(candidate.takeProfits) ? candidate.takeProfits : [];
  const tpMatches = leftTps.filter((takeProfit) => rightTps.some((candidateTp) => arePricesSimilar(takeProfit, candidateTp))).length;

  if (tpMatches > 0) {
    score += Math.min(0.9, tpMatches * 0.3);
  }

  const textSimilarity = computeTokenOverlap(tokenizeText(event.rawText), candidate.tokenizedText || tokenizeText(candidate.rawText));

  if (textSimilarity >= config.telegram.similarityTextThreshold) {
    score += textSimilarity;
  }

  return {
    score: Number(score.toFixed(2)),
    textSimilarity: Number(textSimilarity.toFixed(2)),
  };
}

function assessSignalSimilarity(event) {
  pruneSignalMemory();

  const matches = recentSignalMemory
    .map((candidate) => ({
      candidate,
      similarity: scoreSimilarity(event, candidate),
    }))
    .filter(({ similarity }) => similarity.score >= config.telegram.similarityMinScore)
    .sort((left, right) => right.similarity.score - left.similarity.score);

  const bestMatch = matches[0] || null;
  const signalTimestamp = Date.parse(event.timestamp || 0);
  const signalAgeMinutes = Number.isFinite(signalTimestamp)
    ? Math.max(0, (Date.now() - signalTimestamp) / 60000)
    : 0;
  const hasMatchingOlderSignal = matches.some(({ candidate }) => {
    const candidateTime = Date.parse(candidate.timestamp || 0);
    return Number.isFinite(candidateTime) && candidateTime < signalTimestamp;
  });
  const isLikelyDelayedSignal = config.telegram.freeSignalsLikelyDelayed
    && (
      signalAgeMinutes >= config.telegram.delayedSignalWarningMinutes
      || hasMatchingOlderSignal
    );

  return {
    signalAgeMinutes: Number(signalAgeMinutes.toFixed(1)),
    similarSignalCount: matches.length,
    bestMatch: bestMatch
      ? {
          signalId: bestMatch.candidate.id,
          sourceLabel: bestMatch.candidate.sourceLabel,
          score: bestMatch.similarity.score,
          textSimilarity: bestMatch.similarity.textSimilarity,
          timestamp: bestMatch.candidate.timestamp,
        }
      : null,
    similarSignals: matches.slice(0, 5).map(({ candidate, similarity }) => ({
      signalId: candidate.id,
      sourceLabel: candidate.sourceLabel,
      score: similarity.score,
      textSimilarity: similarity.textSimilarity,
      timestamp: candidate.timestamp,
    })),
    isLikelyDelayedSignal,
    delayReason: isLikelyDelayedSignal
      ? (hasMatchingOlderSignal ? 'similar_signal_seen_earlier' : 'message_age_warning')
      : '',
  };
}

function rememberSignal(event) {
  recentSignalMemory.push(buildSignalMemoryRecord(event));
  pruneSignalMemory();
}

function extractMessage(update) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

function extractMessageText(message) {
  return String(message && (message.text || message.caption) || '').trim();
}

function extractSourceMetadata(message) {
  const forwardOrigin = message.forward_origin || {};
  const forwardedChat = message.forward_from_chat || forwardOrigin.chat || null;

  if (forwardedChat) {
    return {
      sourceChatId: String(forwardedChat.id || ''),
      sourceChatTitle: forwardedChat.title || forwardedChat.username || message.forward_sender_name || '',
    };
  }

  return {
    sourceChatId: String((message.chat && message.chat.id) || ''),
    sourceChatTitle: (message.chat && (message.chat.title || message.chat.username)) || '',
  };
}

function parseSide(text) {
  const upper = String(text || '').toUpperCase();

  if (/\b(BUY|LONG)\b/.test(upper)) {
    return 'BUY';
  }

  if (/\b(SELL|SHORT)\b/.test(upper)) {
    return 'SELL';
  }

  return null;
}

function parseQty(text) {
  const upper = String(text || '').toUpperCase();
  const match = upper.match(/\b(?:LOT|LOTS|QTY|SIZE|VOLUME)\s*[:=]?\s*(\d+(?:\.\d+)?)\b/);
  return match ? Number(match[1]) : null;
}

function parseNumberFromPattern(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);

    if (match) {
      const parsed = Number(match[1]);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function parseEntry(text) {
  return parseNumberFromPattern(text, [
    /\bENTRY(?: PRICE| ZONE)?\s*[:=@-]?\s*(\d+(?:\.\d+)?)/i,
    /\b(?:BUY|SELL)(?: NOW| LIMIT| STOP)?\s+[\w/.-]*\s*@\s*(\d+(?:\.\d+)?)/i,
    /@\s*(\d+(?:\.\d+)?)/,
  ]);
}

function parseStopLoss(text) {
  return parseNumberFromPattern(text, [
    /\b(?:STOP ?LOSS|SL)\s*[:=@-]?\s*(\d+(?:\.\d+)?)/i,
  ]);
}

function parseTakeProfits(text) {
  const indexed = new Map();
  const pattern = /\b(?:TAKE ?PROFIT|TP)\s*([123])?\s*[:=@-]?\s*(\d+(?:\.\d+)?)/gi;
  let match = pattern.exec(String(text || ''));

  while (match) {
    const index = Number(match[1] || indexed.size + 1);
    const value = Number(match[2]);

    if (Number.isFinite(value)) {
      indexed.set(index, value);
    }

    match = pattern.exec(String(text || ''));
  }

  return Array.from(indexed.entries())
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
}

function parseTimeframe(text) {
  const match = String(text || '').match(/\b(M1|M5|M15|M30|H1|H4|D1|W1|MN1)\b/i);
  return match ? match[1].toUpperCase() : '';
}

function parseConfidenceLabel(text) {
  const match = String(text || '').match(/\bCONFIDENCE\s*[:=-]\s*([A-Z ]{2,20})/i);
  return match ? match[1].trim() : '';
}

function parseSourceLabel(text, sourceMetadata) {
  const match = String(text || '').match(/(?:\[SOURCE\]|\bSOURCE\b)\s*(?:[:=\-])?\s*([^\n\r]+)/i);
  return match ? match[1].trim() : sourceMetadata.sourceChatTitle || '';
}

function parseTradeUpdateActions(text) {
  const upper = String(text || '').toUpperCase();
  const actions = [];

  if (/\bTP\s*1\b.*\b(HIT|DONE|ACHIEVED|REACHED)\b|\bFIRST TP\b/i.test(upper)) {
    actions.push('tp1_hit');
  }

  if (/\bTP\s*2\b.*\b(HIT|DONE|ACHIEVED|REACHED)\b|\bSECOND TP\b/i.test(upper)) {
    actions.push('tp2_hit');
  }

  if (/\bTP\s*3\b.*\b(HIT|DONE|ACHIEVED|REACHED)\b|\bTHIRD TP\b|\bFINAL TP\b/i.test(upper)) {
    actions.push('tp3_hit');
  }

  if (/\b(BREAKEVEN|BREAK EVEN|MOVE SL TO BE|MOVE STOP LOSS TO BE|SL TO BE|MOVE SL TO BREAKEVEN)\b/i.test(upper)) {
    actions.push('move_sl_to_breakeven');
  }

  if (/\b(STOP LOSS HIT|SL HIT|STOPPED OUT)\b/i.test(upper)) {
    actions.push('sl_hit');
  }

  if (/\b(CLOSED IN PROFIT|CLOSE IN PROFIT|BOOK PROFIT|TAKE PROFIT NOW)\b/i.test(upper)) {
    actions.push('closed_profit');
  }

  if (/\b(CLOSED IN LOSS|CLOSE IN LOSS)\b/i.test(upper)) {
    actions.push('closed_loss');
  }

  if (/\b(CLOSE NOW|TRADE CLOSED|POSITION CLOSED|CLOSED)\b/i.test(upper) && !actions.includes('closed_profit') && !actions.includes('closed_loss')) {
    actions.push('closed');
  }

  if (/\b(CANCELLED|IGNORE SIGNAL|SETUP CANCELLED|CANCEL SIGNAL)\b/i.test(upper)) {
    actions.push('cancelled');
  }

  return Array.from(new Set(actions));
}

function parseSymbol(texts, allowedSymbols) {
  for (const text of texts) {
    const normalizedText = normalizeSymbol(text);

    for (const symbol of allowedSymbols) {
      if (normalizedText.includes(normalizeSymbol(symbol))) {
        return symbol;
      }

      const aliases = SYMBOL_ALIASES[String(symbol || '').toUpperCase()] || [];

      for (const alias of aliases) {
        if (normalizedText.includes(normalizeSymbol(alias))) {
          return symbol;
        }
      }
    }
  }

  return null;
}

function getRecentSignalConfluence(symbol, options = {}) {
  pruneSignalMemory();

  const normalizedSymbol = normalizeSymbol(symbol);
  const maxAgeMinutes = Number(options.maxAgeMinutes || config.telegram.similarityWindowMinutes);
  const cutoff = Date.now() - (maxAgeMinutes * 60 * 1000);
  const relevant = recentSignalMemory
    .filter((record) => normalizeSymbol(record.symbol) === normalizedSymbol)
    .filter((record) => {
      const timestamp = Date.parse(record.timestamp || 0);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    })
    .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0));

  const buyCount = relevant.filter((record) => String(record.direction || '').toUpperCase() === 'BUY').length;
  const sellCount = relevant.filter((record) => String(record.direction || '').toUpperCase() === 'SELL').length;
  const latest = relevant[0] || null;
  const latestTimestamp = Date.parse((latest && latest.timestamp) || 0);
  const latestAgeMinutes = Number.isFinite(latestTimestamp)
    ? Math.max(0, (Date.now() - latestTimestamp) / 60000)
    : null;

  return {
    symbol,
    count: relevant.length,
    buyCount,
    sellCount,
    latestDirection: latest ? String(latest.direction || '').toUpperCase() : null,
    latestAgeMinutes: Number.isFinite(latestAgeMinutes) ? Number(latestAgeMinutes.toFixed(1)) : null,
    consensusDirection: buyCount === sellCount
      ? null
      : buyCount > sellCount
        ? 'BUY'
        : 'SELL',
    sources: Array.from(new Set(relevant.map((record) => record.sourceLabel).filter(Boolean))),
  };
}

function buildBaseEvent(message, update, text) {
  const sourceMetadata = extractSourceMetadata(message);
  const replyText = extractMessageText(message.reply_to_message || {});
  const replySourceMetadata = message.reply_to_message ? extractSourceMetadata(message.reply_to_message) : sourceMetadata;
  const timestamp = new Date(((message.date || Math.floor(Date.now() / 1000)) * 1000)).toISOString();

  return {
    updateId: update.update_id,
    id: `tg-${message.chat.id}-${message.message_id}`,
    chatId: String(message.chat.id),
    chatTitle: message.chat.title || message.chat.username || '',
    messageId: message.message_id,
    replyToMessageId: message.reply_to_message ? message.reply_to_message.message_id : null,
    text,
    rawText: text,
    replyText,
    timestamp,
    source: 'telegram',
    sourceChatId: sourceMetadata.sourceChatId || replySourceMetadata.sourceChatId,
    sourceChatTitle: sourceMetadata.sourceChatTitle || replySourceMetadata.sourceChatTitle,
  };
}

function enrichSignalEvent(event) {
  const similarityAssessment = assessSignalSimilarity(event);
  const confidenceParts = [];

  if (event.confidenceLabel) {
    confidenceParts.push(event.confidenceLabel);
  }

  if (similarityAssessment.similarSignalCount > 0) {
    confidenceParts.push(`Consensus ${similarityAssessment.similarSignalCount + 1} sources`);
  }

  if (similarityAssessment.isLikelyDelayedSignal) {
    confidenceParts.push('Free source may be delayed');
  }

  const enriched = {
    ...event,
    signalAgeMinutes: similarityAssessment.signalAgeMinutes,
    similarSignalCount: similarityAssessment.similarSignalCount,
    similarityAssessment,
    isLikelyDelayedSignal: similarityAssessment.isLikelyDelayedSignal,
    delayReason: similarityAssessment.delayReason,
    confidenceLabel: confidenceParts.join(' | '),
  };

  rememberSignal(enriched);
  return enriched;
}

function parseTelegramEvent(update, allowedSymbols) {
  const message = extractMessage(update);

  if (!message || !message.chat) {
    return null;
  }

  if (String(message.chat.id) !== String(config.telegram.chatId)) {
    return null;
  }

  const text = extractMessageText(message);

  if (!text) {
    return null;
  }

  const baseEvent = buildBaseEvent(message, update, text);
  const symbol = parseSymbol([text, baseEvent.replyText], allowedSymbols);
  const side = parseSide(text);
  const actions = parseTradeUpdateActions(text);
  const takeProfits = parseTakeProfits(text);
  const stopLoss = parseStopLoss(text);
  const entry = parseEntry(text);
  const looksLikeSignal = Boolean(
    side &&
    symbol &&
    (
      entry != null ||
      stopLoss != null ||
      takeProfits.length > 0 ||
      /\b(ENTRY|SIGNAL|SETUP|LIMIT)\b/i.test(text)
    )
  );

  if (looksLikeSignal || (side && symbol && actions.length === 0)) {
    return enrichSignalEvent({
      ...baseEvent,
      eventType: 'signal',
      symbol,
      side,
      direction: side,
      qty: parseQty(text),
      entry,
      stopLoss,
      takeProfits,
      timeframe: parseTimeframe(text),
      confidenceLabel: parseConfidenceLabel(text),
      sourceLabel: parseSourceLabel(text, baseEvent),
    });
  }

  if (actions.length > 0 && symbol) {
    return {
      ...baseEvent,
      eventType: 'trade_update',
      symbol,
      direction: side,
      actions,
      sourceLabel: parseSourceLabel(text, baseEvent),
    };
  }

  return null;
}

async function callTelegram(method, payload) {
  if (!config.telegram.botToken) {
    throw new Error('Missing Telegram bot token');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.telegram.requestTimeoutMs);

  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram request failed: ${response.status} ${body}`);
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    return data.result || [];
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Telegram request timed out after ${config.telegram.requestTimeoutMs}ms`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollTelegramSignals(allowedSymbols = []) {
  if (!config.telegram.enabled) {
    return [];
  }

  if (!config.telegram.chatId) {
    throw new Error('Missing Telegram signal chat id');
  }

  const updates = await callTelegram('getUpdates', {
    offset: updateOffset,
    timeout: 0,
    limit: 20,
    allowed_updates: config.telegram.allowedUpdates,
  });

  const events = [];
  let hasNewOffset = false;

  for (const update of updates) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);
    hasNewOffset = true;

    const event = parseTelegramEvent(update, allowedSymbols);

    if (event) {
      events.push(event);
    }
  }

  if (hasNewOffset) {
    saveUpdateOffset(updateOffset);
  }

  return events;
}

module.exports = {
  parseTelegramEvent,
  pollTelegramSignals,
  getRecentSignalConfluence,
};
