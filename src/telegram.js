const fs = require('fs');
const path = require('path');
const config = require('./config');

const updateOffsetPath = path.join(__dirname, '..', 'logs', 'telegram-offset.txt');

function loadUpdateOffset() {
  if (!fs.existsSync(updateOffsetPath)) {
    return 0;
  }

  const rawValue = fs.readFileSync(updateOffsetPath, 'utf8').trim();
  const parsed = Number(rawValue);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function saveUpdateOffset(offset) {
  fs.writeFileSync(updateOffsetPath, String(offset));
}

let updateOffset = loadUpdateOffset();

function normalizeSymbol(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function extractMessage(update) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
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
  const match = upper.match(/\b(?:LOT|LOTS|QTY|SIZE)\s*[:=]?\s*(\d+(?:\.\d+)?)\b/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function parseSymbol(text, allowedSymbols) {
  const normalizedText = normalizeSymbol(text);

  for (const symbol of allowedSymbols) {
    if (normalizedText.includes(normalizeSymbol(symbol))) {
      return symbol;
    }
  }

  return null;
}

function parseSignalUpdate(update, allowedSymbols) {
  const message = extractMessage(update);

  if (!message || !message.chat) {
    return null;
  }

  if (String(message.chat.id) !== String(config.telegram.chatId)) {
    return null;
  }

  const text = message.text || message.caption || '';
  const side = parseSide(text);

  if (!side) {
    return null;
  }

  const symbol = parseSymbol(text, allowedSymbols);

  if (!symbol) {
    return null;
  }

  return {
    updateId: update.update_id,
    chatId: String(message.chat.id),
    text,
    side,
    symbol,
    qty: parseQty(text),
    source: 'telegram',
  };
}

async function callTelegram(method, payload) {
  if (!config.telegram.botToken) {
    throw new Error('Missing Telegram bot token');
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
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

  const signals = [];
  let hasNewOffset = false;

  for (const update of updates) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);
    hasNewOffset = true;

    const signal = parseSignalUpdate(update, allowedSymbols);

    if (signal) {
      signals.push(signal);
    }
  }

  if (hasNewOffset) {
    saveUpdateOffset(updateOffset);
  }

  return signals;
}

module.exports = {
  pollTelegramSignals,
};
