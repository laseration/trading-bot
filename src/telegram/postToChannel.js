const { log } = require('../logger');
const { callPostBotApi, getPostingConfig } = require('./telegramApi');
const { sendPhotoToChannel } = require('./sendPhotoToChannel');

async function sendMessageToChannel(text) {
  const postingConfig = getPostingConfig();
  const messages = [];
  const chunks = [];
  let remaining = String(text || '');

  while (remaining.length > 3900) {
    const splitIndex = remaining.lastIndexOf('\n', 3900);
    const nextChunk = remaining.slice(0, splitIndex > 0 ? splitIndex : 3900).trim();
    chunks.push(nextChunk);
    remaining = remaining.slice(nextChunk.length).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  for (const chunk of chunks) {
    const result = await callPostBotApi('sendMessage', {
      chat_id: postingConfig.channelId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    messages.push(result);
  }

  return messages[messages.length - 1] || null;
}

async function postToChannel({ caption, imageBuffer, filename, preferText = false }) {
  const postingConfig = getPostingConfig();

  if (!postingConfig.enabled) {
    log('[TELEGRAM_POST] Posting bot not configured, skipping publish');
    return null;
  }

  try {
    let result;
    let sentAs = 'text';

    if (imageBuffer && !preferText) {
      try {
        result = await sendPhotoToChannel({
          caption,
          imageBuffer,
          filename,
        });
        sentAs = 'photo';
        log('[TELEGRAM_POST] Image post sent successfully');
      } catch (imageErr) {
        log(`[TELEGRAM_POST] Image post failed, falling back to text: ${imageErr.message}`);
      }
    }

    if (!result) {
      result = await sendMessageToChannel(caption);
      log('[TELEGRAM_POST] Text post sent successfully');
    }

    return {
      channelId: postingConfig.channelId,
      messageId: result && result.message_id,
      sentAs,
      timestamp: new Date().toISOString(),
      raw: result,
    };
  } catch (err) {
    log(`[TELEGRAM_POST] Publish failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  postToChannel,
};
