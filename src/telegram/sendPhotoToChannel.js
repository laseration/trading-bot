const { callPostBotApi, getPostingConfig } = require('./telegramApi');

async function sendPhotoToChannel({ caption, imageBuffer, filename = 'signal-card.png' }) {
  const postingConfig = getPostingConfig();
  const form = new FormData();

  form.append('chat_id', postingConfig.channelId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), filename);

  return callPostBotApi('sendPhoto', form, { multipart: true });
}

module.exports = {
  sendPhotoToChannel,
};
