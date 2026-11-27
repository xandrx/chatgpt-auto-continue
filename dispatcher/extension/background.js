const API_BASE = 'https://csd.guddom.com';
const SESSIONS_KEY = 'csd_sessions_v1';
const ENABLED_KEY = 'csd_remote_enabled_v1';

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith('chrome-extension://' + chrome.runtime.id + '/');
}
function isChatPage(sender, chatId) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string' ||
      typeof chatId !== 'string') return false;
  let url;
  try { url = new URL(sender.url); } catch (_) { return false; }
  const segments = url.pathname.split('/');
  return url.origin === 'https://chatgpt.com' && segments[1] === 'c' && segments[2] === chatId;
}
function validChatId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,256}$/.test(value);
}
function validWorker(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
async function readStore(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] === undefined ? fallback : data[key];
}
async function writeStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
async function apiRequest(path, method, body, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(data?.error || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function getSessions() {
  const value = await readStore(SESSIONS_KEY, {});
  return value && typeof value === 'object' ? value : {};
}
async function getSession(chatId) {
  if (!validChatId(chatId)) throw new Error('invalid chat id');
  const sessions = await getSessions();
  const session = sessions[chatId];
  if (!session || typeof session.sessionId !== 'string') throw new Error('chat is not registered');
  return { sessions, session };
}
async function getRemoteEnabled(chatId) {
  const settings = await readStore(ENABLED_KEY, {});
  return Boolean(settings && settings[chatId] === true);
}
async function setRemoteEnabled(chatId, enabled) {
  const settings = await readStore(ENABLED_KEY, {});
  const next = settings && typeof settings === 'object' ? settings : {};
  next[chatId] = Boolean(enabled);
  await writeStore(ENABLED_KEY, next);
}
async function registerChat(message) {
  if (!validChatId(message.chatId)) throw new Error('open a saved ChatGPT conversation first');
  const sessions = await getSessions();
  if (sessions[message.chatId]) {
    const existing = sessions[message.chatId];
    return { registered: true, alreadyRegistered: true, revoked: existing.revoked === true, alias: existing.alias || '' };
  }
  const alias = String(message.alias || 'ChatGPT tab').trim().slice(0, 128) || 'ChatGPT tab';
  const enrolled = await apiRequest('/v1/client/enroll', 'POST', {
    chat_id: message.chatId,
    alias,
    export_allowed: message.exportAllowed === true
  });
  if (!enrolled?.session?.id) throw new Error('invalid server enrollment response');
  sessions[message.chatId] = {
    sessionId: enrolled.session.id,
    epoch: Number(enrolled.session.epoch) || 0,
    exportAllowed: enrolled.session.export_allowed === true,
    alias,
    chatId: message.chatId
  };
  await writeStore(SESSIONS_KEY, sessions);
  return { registered: true, alreadyRegistered: false, alias };
}
async function handleMessageUnsafe(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('invalid message');
  if (message.type.startsWith('popup.')) {
    if (!isExtensionPage(sender)) throw new Error('not authorized');
    if (message.type === 'popup.register') return registerChat(message);
    if (message.type === 'popup.state') {
      if (!validChatId(message.chatId)) return { registered: false, remoteEnabled: false };
      const sessions = await getSessions();
      const session = sessions[message.chatId] || null;
      return {
        registered: Boolean(session),
        remoteEnabled: await getRemoteEnabled(message.chatId),
        exportAllowed: session?.exportAllowed === true,
        revoked: session?.revoked === true,
        alias: session?.alias || ''
      };
    }
    if (message.type === 'popup.setRemote') {
      if (!validChatId(message.chatId)) throw new Error('invalid chat id');
      const { session } = await getSession(message.chatId);
      await setRemoteEnabled(message.chatId, message.enabled === true);
      return { ok: true, remoteEnabled: message.enabled === true, exportAllowed: session.exportAllowed === true };
    }
    throw new Error('unknown popup action');
  }

  if (!isChatPage(sender, message.chatId)) throw new Error('not authorized');
  if (!validChatId(message.chatId)) throw new Error('invalid chat id');
  const { sessions, session } = await getSession(message.chatId);
  const worker = message.worker;
  if (!validWorker(worker)) throw new Error('invalid worker id');

  if (message.type === 'content.state') {
    return {
      registered: true,
      remoteEnabled: await getRemoteEnabled(message.chatId),
      exportAllowed: session.exportAllowed === true,
      epoch: Number(session.epoch) || 0
    };
  }
  if (message.type === 'content.heartbeat') {
    const status = ['idle', 'busy', 'blocked'].includes(message.status) ? message.status : 'busy';
    const result = await apiRequest(
      '/v1/sessions/' + encodeURIComponent(session.sessionId) + '/heartbeat',
      'POST',
      { chat_id: message.chatId, worker, epoch: Number(session.epoch) || 0, status },
      10000
    );
    session.epoch = Number(result.epoch) || 0;
    sessions[message.chatId] = session;
    await writeStore(SESSIONS_KEY, sessions);
    return { ok: true, epoch: session.epoch };
  }
  if (message.type === 'content.wait') {
    if (!(await getRemoteEnabled(message.chatId))) return { job: null, disabled: true };
    const waitMs = Math.max(0, Math.min(20000, Number(message.waitMs) || 5000));
    return await apiRequest(
      '/v1/sessions/' + encodeURIComponent(session.sessionId) + '/wait',
      'POST',
      { chat_id: message.chatId, worker, epoch: Number(session.epoch) || 0, wait_ms: waitMs },
      waitMs + 7000
    );
  }
  if (message.type === 'content.ack') {
    const state = String(message.state || '');
    if (!['submitted', 'completed', 'failed', 'uncertain'].includes(state)) {
      throw new Error('invalid acknowledgement state');
    }
    const resultText = session.exportAllowed && state === 'completed' &&
      typeof message.result === 'string' ? message.result.slice(0, 38000) : '';
    return await apiRequest(
      '/v1/sessions/' + encodeURIComponent(session.sessionId) + '/ack',
      'POST',
      {
        chat_id: message.chatId,
        worker,
        epoch: Number(session.epoch) || 0,
        request_id: String(message.requestId || ''),
        state,
        result: resultText
      },
      12000
    );
  }
  throw new Error('unknown content action');
}

async function handleMessage(message, sender) {
  try {
    return await handleMessageUnsafe(message, sender);
  } catch (error) {
    const sessionRejected = error?.status === 401 ||
      (error?.status === 404 && ['content.heartbeat', 'content.wait'].includes(message?.type));
    if (validChatId(message?.chatId) && isChatPage(sender, message.chatId) && sessionRejected) {
      // A revoked/missing server session must fail closed locally as well.
      await setRemoteEnabled(message.chatId, false);
      const sessions = await getSessions();
      if (sessions[message.chatId]) {
        sessions[message.chatId].revoked = true;
        await writeStore(SESSIONS_KEY, sessions);
      }
      throw new Error('server session revoked or missing; remote tasks disabled — administrator action required');
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || 'dispatcher error').slice(0, 180) }));
  return true;
});
