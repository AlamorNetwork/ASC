import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.botToken}`;
const FILE_API = `https://api.telegram.org/file/bot${config.botToken}`;

async function call(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

export const getMe = () => call('getMe', {});

/** Long polling. No webhook, no public URL, no tunnel. */
export async function* updates({ timeout = 30 } = {}) {
  let offset = 0;
  for (;;) {
    let batch;
    try {
      batch = await call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] });
    } catch (err) {
      console.error('[telegram] poll failed:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of batch) {
      offset = u.update_id + 1;
      yield u;
    }
  }
}

export async function downloadFile(fileId) {
  const meta = await call('getFile', { file_id: fileId });
  const res = await fetch(`${FILE_API}/${meta.file_path}`);
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const CHUNK = 3900; // Telegram's limit is 4096; leave room for entities

export async function send(chatId, text, { buttons, replyTo } = {}) {
  const parts = [];
  let rest = text;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK * 0.5) cut = CHUNK;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);

  let last;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    last = await call('sendMessage', {
      chat_id: chatId,
      text: parts[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyTo && i === 0 ? { reply_to_message_id: replyTo } : {}),
      ...(buttons && isLast ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }
  return last;
}

export const edit = (chatId, messageId, text, buttons) =>
  call('editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  }).catch(() => null); // editing an unchanged message is not an error worth raising

export const answerCallback = (id, text) =>
  call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => null);

export const typing = (chatId) =>
  call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => null);

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
