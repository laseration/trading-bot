const config = require('../config');

function getPostingConfig() {
  return {
    enabled: Boolean(config.telegram.postBotToken && config.telegram.postChannelId),
    botToken: config.telegram.postBotToken,
    channelId: config.telegram.postChannelId,
  };
}

async function callPostBotApi(method, payload, { multipart = false } = {}) {
  const postingConfig = getPostingConfig();

  if (!postingConfig.enabled) {
    throw new Error('Telegram posting bot is not configured');
  }

  const response = await fetch(`https://api.telegram.org/bot${postingConfig.botToken}/${method}`, {
    method: 'POST',
    headers: multipart ? undefined : { 'Content-Type': 'application/json' },
    body: multipart ? payload : JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram posting request failed: ${response.status} ${body}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram posting API error: ${data.description || 'Unknown error'}`);
  }

  return data.result;
}

module.exports = {
  callPostBotApi,
  getPostingConfig,
};
