'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const storage = {};
const calls = [];
let listener;
let revokeServer = false;
const chrome = {
  runtime: {
    id: 'fixture-extension-id',
    onMessage: { addListener(fn) { listener = fn; } }
  },
  storage: {
    local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, values); }
    }
  }
};
async function fakeFetch(url, options) {
  calls.push({ url, options });
  let data = {};
  if (url.endsWith('/v1/client/enroll')) {
    data = { session: { id: 'session-123', epoch: 0, export_allowed: options.body.includes('"export_allowed":true') } };
  } else if (url.endsWith('/heartbeat')) {
    if (revokeServer) return { ok: false, status: 401, async json() { return { error: 'unauthorized' }; } };
    data = { epoch: 1 };
  } else if (url.endsWith('/wait')) {
    data = { job: null };
  } else if (url.endsWith('/ack')) {
    data = { ok: true };
  }
  return { ok: true, status: 200, async json() { return data; } };
}
const context = {
  chrome, fetch: fakeFetch, AbortController, setTimeout, clearTimeout,
  console, URL, encodeURIComponent
};
vm.runInNewContext(fs.readFileSync('dispatcher/extension/background.js', 'utf8'), context);
const extensionSender = { id: chrome.runtime.id, url: 'chrome-extension://fixture-extension-id/popup.html' };
const chatSender = { id: chrome.runtime.id, url: 'https://chatgpt.com/c/abcdef123456' };
const chatSender2 = { id: chrome.runtime.id, url: 'https://chatgpt.com/c/bcdefa123456' };
const forgedSender = { id: chrome.runtime.id, url: 'https://evil.example/' };

function send(message, sender) {
  return new Promise(resolve => {
    const keepChannel = listener(message, sender, resolve);
    assert.equal(keepChannel, true);
  });
}
(async () => {
  let response = await send({
    type: 'popup.register', chatId: 'abcdef123456',
    alias: 'Fixture', exportAllowed: true
  }, extensionSender);
  assert.equal(response.ok, true);
  assert.equal(response.result.registered, true);
  const sessions = storage.csd_sessions_v1;
  assert.equal(sessions['abcdef123456'].sessionId, 'session-123');
  assert.equal(Object.hasOwn(sessions['abcdef123456'], 'credential'), false);
  assert.equal(Object.hasOwn(sessions['abcdef123456'], 'token'), false);
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.headers.Authorization, undefined);

  response = await send({
    type: 'content.state', chatId: 'abcdef123456', worker: 'fixture-worker'
  }, chatSender);
  assert.equal(response.ok, true);
  assert.equal(response.result.registered, true);
  assert.equal(response.result.remoteEnabled, false);

  response = await send({
    type: 'content.wait', chatId: 'abcdef123456', worker: 'fixture-worker'
  }, chatSender);
  assert.equal(response.ok, true);
  assert.equal(response.result.disabled, true);
  assert.equal(calls.length, 1, 'remote-off must not contact the queue');

  response = await send({
    type: 'popup.setRemote', chatId: 'abcdef123456', enabled: true
  }, forgedSender);
  assert.equal(response.ok, false, 'web page cannot change extension settings');

  response = await send({
    type: 'popup.setRemote', chatId: 'abcdef123456', enabled: true
  }, extensionSender);
  assert.equal(response.ok, true);
  response = await send({
    type: 'content.heartbeat', chatId: 'abcdef123456',
    worker: 'fixture-worker', status: 'idle'
  }, chatSender);
  assert.equal(response.ok, true);
  assert.equal(response.result.epoch, 1);
  response = await send({
    type: 'content.wait', chatId: 'abcdef123456',
    worker: 'fixture-worker', waitMs: 5000
  }, chatSender);
  assert.equal(response.ok, true);
  assert.equal(response.result.job, null);

  response = await send({
    type: 'content.ack', chatId: 'abcdef123456',
    worker: 'fixture-worker', requestId: 'job-1',
    state: 'completed', result: 'fixture answer'
  }, chatSender);
  assert.equal(response.ok, true);
  const ack = calls.find(call => call.url.endsWith('/ack'));
  assert.equal(JSON.parse(ack.options.body).result, 'fixture answer');

  response = await send({
    type: 'popup.register', chatId: 'bcdefa123456',
    alias: 'No export fixture', exportAllowed: false
  }, extensionSender);
  assert.equal(response.ok, true);
  response = await send({
    type: 'content.ack', chatId: 'bcdefa123456',
    worker: 'fixture-worker', requestId: 'job-no-export',
    state: 'completed', result: 'must not leave the browser'
  }, chatSender2);
  assert.equal(response.ok, true);
  response = await send({
    type: 'content.state', chatId: 'bcdefa123456', worker: 'fixture-worker'
  }, chatSender);
  assert.equal(response.ok, false, 'one ChatGPT tab cannot address another chat session');
  const noExportAck = calls.filter(call => call.url.endsWith('/ack')).at(-1);
  assert.equal(JSON.parse(noExportAck.options.body).result, '');

  response = await send({
    type: 'content.ack', chatId: 'abcdef123456',
    worker: 'fixture-worker', requestId: 'job-2',
    state: 'completed', result: 'fixture answer'
  }, forgedSender);
  assert.equal(response.ok, false, 'non-ChatGPT sender cannot access session APIs');

  revokeServer = true;
  response = await send({
    type: 'content.heartbeat', chatId: 'abcdef123456',
    worker: 'fixture-worker', status: 'idle'
  }, chatSender);
  assert.equal(response.ok, false, 'revoked server session must reject heartbeat');
  assert.match(response.error, /revoked or missing/);
  assert.equal(storage.csd_remote_enabled_v1['abcdef123456'], false);
  assert.equal(storage.csd_sessions_v1['abcdef123456'].revoked, true);
  response = await send({
    type: 'popup.state', chatId: 'abcdef123456'
  }, extensionSender);
  assert.equal(response.result.revoked, true);
  assert.equal(response.result.remoteEnabled, false);

  console.log('MV3 background tests passed: sender isolation, opt-in default, cookie-only auth, no-store, heartbeat, wait and gated export');
})().catch(error => { console.error(error); process.exitCode = 1; });
