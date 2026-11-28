(() => {
  'use strict';

  const HEARTBEAT_MS = 12000;
  const POLL_WAIT_MS = 5000;
  const SUBMIT_READY_MS = 20000;
  const SUBMIT_CONFIRM_MS = 15000;
  const START_TIMEOUT_MS = 90000;
  const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
  const QUIET_MS = 5000;
  const ACTIVITY_MS = 2500;

  let chatId = getChatId();
  let registered = false;
  let remoteEnabled = false;
  let exportAllowed = false;
  let activeJob = null;
  let heartbeatBusy = false;
  let pollBusy = false;
  let nextPollAt = 0;
  let pollBackoffMs = 2000;
  let lastHeartbeat = 0;
  let lastHeartbeatStatus = '';
  let lastStateRefresh = 0;
  let lastError = '';
  let pulseBusy = false;
  let lastObservedAssistantText = null;
  let lastAssistantChangeAt = 0;

  function getChatId() {
    const match = (location.pathname || '').match(/\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    return match?.[1] || null;
  }
  function aliasFromTitle() {
    return String(document.title || 'ChatGPT tab')
      .replace(/^(?:(?:🟠|🟢|\?\?)\s*)?\[[^\]]+\]\s*/u, '')
      .slice(0, 128) || 'ChatGPT tab';
  }
  function sendBackground(message) {
    return chrome.runtime.sendMessage(message).then(response => {
      if (!response?.ok) throw new Error(response?.error || 'dispatcher request failed');
      return response.result;
    });
  }
  function getComposerText(el) {
    if (!el) return '';
    return typeof el.value === 'string' ? el.value : (el.innerText || el.textContent || '');
  }
  function normalize(value) {
    return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }
  function isVisible(el) {
    if (!el?.isConnected || !el.getClientRects?.().length) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || rect.right <= 0 || rect.bottom <= 0 ||
        rect.left >= innerWidth || rect.top >= innerHeight) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' && style.opacity !== '0';
  }
  function getComposerInput() {
    const selectors = [
      '#prompt-textarea[contenteditable="true"]',
      '[data-composer-layout] .ProseMirror[contenteditable="true"]',
      '[class*="ComposerLayoutRoot"] .ProseMirror[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"][data-composer-markdown]',
      'main .ProseMirror[contenteditable="true"]',
      'main [role="textbox"][contenteditable="true"]',
      '#prompt-textarea:where(textarea,input)'
    ];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(el => isVisible(el) && !el.disabled && !el.readOnly &&
        el.getAttribute('aria-disabled') !== 'true' &&
        !el.closest('[data-message-author-role]'));
    const rich = candidates.filter(el => el.getAttribute('contenteditable') === 'true');
    const preferred = rich.length ? rich : candidates;
    return preferred.find(el => el === document.activeElement || el.contains(document.activeElement)) ||
      preferred[0] || null;
  }
  function getSendButton(input = getComposerInput()) {
    if (!input) return null;
    const layout = input.closest('[data-composer-layout], [class*="ComposerLayoutRoot"]');
    const main = input.closest('main') || document.querySelector('main');
    const scopes = [...new Set([input.closest('form'), layout, main, document].filter(Boolean))];
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[data-composer-submit="true"]',
      'button#composer-submit-button',
      'button[aria-label]',
      'button[title]'
    ];
    const candidates = new Set(scopes.flatMap(scope =>
      selectors.flatMap(selector => [...scope.querySelectorAll(selector)])));
    for (const button of candidates) {
      if (!isVisible(button) || button.closest('[data-message-author-role]')) continue;
      const labels = ['aria-label', 'title', 'data-tooltip-content', 'data-testid']
        .map(name => (button.getAttribute(name) || '').toLowerCase());
      if (labels.some(value => /stop|voice|dictat|record|microphone|останов|голос|диктов|запись|микрофон/.test(value))) continue;
      const explicit = ['send-button', 'composer-send-button'].includes(button.getAttribute('data-testid')) ||
        button.getAttribute('data-composer-submit') === 'true' ||
        labels.some(value => /^(send|send message|send prompt|отправить|отправить сообщение)$/i.test(value.trim()));
      const associated = button.id === 'composer-submit-button' &&
        button.getAttribute('type') === 'submit' && button.form === input.closest('form');
      if (!explicit && !associated) continue;
      if (!button.disabled && button.getAttribute('aria-disabled') !== 'true') return button;
    }
    return null;
  }
  function getStopButton() {
    const selectors = [
      'button[data-composer-stop="true"]',
      'button[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Остановить" i]'
    ];
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .find(isVisible) || null;
  }
  function getAssistantElements() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }
  function getLastAssistantText() {
    const turns = getAssistantElements();
    const last = turns[turns.length - 1];
    return normalize(last?.innerText || last?.textContent || '');
  }
  function getAssistantSnapshot() {
    const turns = getAssistantElements();
    const last = turns[turns.length - 1];
    return {
      count: turns.length,
      id: last?.getAttribute('data-message-id') || last?.getAttribute('data-dil-message-id') || '',
      text: normalize(last?.innerText || last?.textContent || '')
    };
  }
  function getUserSnapshot() {
    const turns = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const last = turns[turns.length - 1];
    return {
      count: turns.length,
      id: last?.getAttribute('data-message-id') || last?.getAttribute('data-dil-message-id') || '',
      text: normalize(last?.innerText || last?.textContent || '')
    };
  }
  function assistantAdvanced(before, after) {
    return after.count > before.count ||
      Boolean(after.id && after.id !== before.id) ||
      Boolean(after.text && after.text !== before.text);
  }
  function hasUnansweredUserTurn() {
    const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const assistants = getAssistantElements();
    const user = users[users.length - 1];
    const assistant = assistants[assistants.length - 1];
    if (!user) return false;
    if (!assistant) return true;
    return Boolean(user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_PRECEDING);
  }
  function getGenerationSignals() {
    const stop = Boolean(getStopButton());
    const busy = Boolean(document.querySelector(
      '[data-message-author-role="assistant"][aria-busy="true"], [data-message-author-role="assistant"] [aria-busy="true"]'
    ));
    const sidebarWorking = Boolean(document.querySelector(
      '[data-sidebar-indicator="working"], nav [aria-busy="true"], aside [data-loading-indicator]'
    ));
    const unanswered = hasUnansweredUserTurn();
    const assistantText = getLastAssistantText();
    if (lastObservedAssistantText !== null && assistantText !== lastObservedAssistantText) {
      lastAssistantChangeAt = Date.now();
    }
    lastObservedAssistantText = assistantText;
    const recentActivity = lastAssistantChangeAt > 0 && Date.now() - lastAssistantChangeAt < ACTIVITY_MS;
    const alertPattern = /something went wrong|error (?:while |in )?generating|network error|too many requests|rate limit|usage limit|что-то пошло не так|ошибка (?:при )?генерации|ошибка сети|лимит[^.!?]{0,50}(?:исчерпан|достигнут)/iu;
    const alert = [...document.querySelectorAll(
      'main [role="alert"], main [data-testid="error-message"], main [data-testid="rate-limit-message"]'
    )].some(el => isVisible(el) && alertPattern.test(normalize(el.innerText || el.textContent)));
    return { stop, busy, sidebarWorking, unanswered, recentActivity, alert,
      active: stop || busy || sidebarWorking || unanswered || recentActivity };
  }
  function chatIsIdle() {
    const input = getComposerInput();
    const signals = getGenerationSignals();
    return Boolean(chatId && input && !signals.active && !signals.alert &&
      !normalize(getComposerText(input)));
  }
  function safeToReceive() {
    return Boolean(!activeJob && chatIsIdle());
  }
  function setComposerText(input, value) {
    if (!input || !input.isConnected || normalize(getComposerText(input))) return false;
    input.focus();
    if (typeof input.value === 'string') {
      const proto = input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return normalize(getComposerText(input)) === normalize(value);
    }
    if (input.getAttribute('contenteditable') !== 'true') return false;
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, value);
    return normalize(getComposerText(input)) === normalize(value);
  }
  function clearOwnedDraft(input, prompt) {
    if (!input?.isConnected || normalize(getComposerText(input)) !== normalize(prompt)) return;
    if (typeof input.value === 'string') {
      const proto = input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, '');
      else input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } else {
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.execCommand('delete', false);
    }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function submitPrompt(prompt, targetChatId) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) return 'failed';
    if (getChatId() !== targetChatId || !remoteEnabled || !chatIsIdle()) return 'failed';
    const input = getComposerInput();
    if (!setComposerText(input, prompt)) return 'failed';
    const readyDeadline = Date.now() + SUBMIT_READY_MS;
    let sendButton = null;
    while (Date.now() < readyDeadline) {
      if (getChatId() !== targetChatId) {
        clearOwnedDraft(input, prompt);
        return 'failed';
      }
      if (!remoteEnabled) {
        clearOwnedDraft(input, prompt);
        return 'failed';
      }
      if (!input.isConnected || normalize(getComposerText(input)) !== normalize(prompt)) return 'failed';
      if (getGenerationSignals().active) {
        clearOwnedDraft(input, prompt);
        return 'failed';
      }
      sendButton = getSendButton(input);
      if (sendButton) break;
      await sleep(200);
    }
    if (!sendButton) {
      clearOwnedDraft(input, prompt);
      return 'failed';
    }
    const beforeUser = getUserSnapshot();
    const beforeAssistant = getAssistantSnapshot();
    if (getStopButton()) {
      clearOwnedDraft(input, prompt);
      return 'failed';
    }
    try { sendButton.click(); } catch (_) {
      clearOwnedDraft(input, prompt);
      return 'failed';
    }

    const confirmDeadline = Date.now() + SUBMIT_CONFIRM_MS;
    while (Date.now() < confirmDeadline) {
      if (getChatId() !== targetChatId) return 'uncertain';
      const afterUser = getUserSnapshot();
      const afterAssistant = getAssistantSnapshot();
      const editorText = getComposerText(getComposerInput());
      const stopAppeared = Boolean(getStopButton());
      const newUser = afterUser.count > beforeUser.count ||
        Boolean(afterUser.id && afterUser.id !== beforeUser.id);
      const matchingUser = newUser && afterUser.text.includes(normalize(prompt));
      if (stopAppeared || matchingUser ||
          (assistantAdvanced(beforeAssistant, afterAssistant) && !normalize(editorText))) {
        return 'submitted';
      }
      await sleep(200);
    }
    return 'uncertain';
  }

  async function waitForCompletion(job, targetChatId, beforeAssistant) {
    const startDeadline = Date.now() + START_TIMEOUT_MS;
    let started = false;
    let sawAssistantAdvance = false;
    let latestText = beforeAssistant.text;
    let lastChangeAt = Date.now();
    while (Date.now() < startDeadline) {
      if (getChatId() !== targetChatId) return { state: 'uncertain', result: '' };
      const current = getAssistantSnapshot();
      if (current.text !== latestText) {
        latestText = current.text;
        lastChangeAt = Date.now();
      }
      const signals = getGenerationSignals();
      if (assistantAdvanced(beforeAssistant, current)) sawAssistantAdvance = true;
      if (sawAssistantAdvance || signals.stop || signals.busy || signals.sidebarWorking) {
        started = true;
        break;
      }
      if (signals.alert) return { state: 'uncertain', result: '' };
      await sleep(400);
    }
    if (!started) return { state: 'uncertain', result: '' };

    const endDeadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let quietSince = 0;
    while (Date.now() < endDeadline) {
      if (getChatId() !== targetChatId) return { state: 'uncertain', result: '' };
      const current = getAssistantSnapshot();
      if (current.text !== latestText) {
        latestText = current.text;
        lastChangeAt = Date.now();
      }
      const signals = getGenerationSignals();
      if (assistantAdvanced(beforeAssistant, current)) sawAssistantAdvance = true;
      if (signals.alert) return { state: 'uncertain', result: '' };
      const recentText = Date.now() - lastChangeAt < ACTIVITY_MS;
      const active = signals.stop || signals.busy || signals.sidebarWorking || signals.unanswered || recentText;
      if (active) {
        quietSince = 0;
      } else {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= QUIET_MS) {
          const result = getLastAssistantText();
          return result && sawAssistantAdvance ? { state: 'completed', result } : { state: 'uncertain', result: '' };
        }
      }
      await sleep(500);
    }
    return { state: 'uncertain', result: '' };
  }

  async function acknowledge(job, state, result = '') {
    try {
      await sendBackground({
        type: 'content.ack',
        chatId: job.chatId,
        requestId: job.id,
        state,
        result
      });
      return true;
    } catch (error) {
      lastError = String(error?.message || 'ack failed');
      return false;
    }
  }
  async function processJob(job, targetChatId) {
    const active = {
      id: job.id,
      chatId: targetChatId,
      prompt: job.prompt
    };
    activeJob = active;
    const beforeAssistant = getAssistantSnapshot();
    try {
      await refreshState();
      if (!remoteEnabled || getChatId() !== targetChatId || !chatIsIdle()) {
        await acknowledge(active, 'failed');
        return;
      }
      const sent = await submitPrompt(job.prompt, targetChatId);
      if (sent !== 'submitted') {
        await acknowledge(active, sent === 'uncertain' ? 'uncertain' : 'failed');
        return;
      }
      const accepted = await acknowledge(active, 'submitted');
      if (!accepted) return;
      const completion = await waitForCompletion(job, targetChatId, beforeAssistant);
      await acknowledge(active, completion.state, completion.result);
    } finally {
      activeJob = null;
    }
  }

  async function refreshState() {
    const current = getChatId();
    if (!current) {
      registered = false;
      remoteEnabled = false;
      return;
    }
    const state = await sendBackground({ type: 'content.state', chatId: current });
    registered = state.registered === true;
    remoteEnabled = state.remoteEnabled === true;
    exportAllowed = state.exportAllowed === true;
  }
  async function heartbeat() {
    if (heartbeatBusy || !registered || !chatId) return;
    heartbeatBusy = true;
    try {
      const safe = chatIsIdle();
      const status = activeJob ? 'busy' : (remoteEnabled && safe ? 'idle' : 'blocked');
      if (Date.now() - lastHeartbeat < HEARTBEAT_MS && status === lastHeartbeatStatus) return;
      const result = await sendBackground({
        type: 'content.heartbeat', chatId, status
      });
      lastHeartbeat = Date.now();
      lastHeartbeatStatus = status;
      lastError = '';
    } catch (error) {
      lastError = String(error?.message || 'heartbeat failed');
      lastHeartbeat = Date.now();
      lastHeartbeatStatus = activeJob ? 'busy' : (remoteEnabled && chatIsIdle() ? 'idle' : 'blocked');
    } finally {
      heartbeatBusy = false;
    }
  }
  async function pollOnce() {
    if (pollBusy || activeJob || !registered || !remoteEnabled || !safeToReceive() || Date.now() < nextPollAt) return;
    pollBusy = true;
    const targetChatId = chatId;
    try {
      const response = await sendBackground({
        type: 'content.wait', chatId: targetChatId, waitMs: POLL_WAIT_MS
      });
      pollBackoffMs = 2000;
      nextPollAt = Date.now();
      if (response?.job && getChatId() === targetChatId) {
        await processJob(response.job, targetChatId);
      } else if (response?.job) {
        await acknowledge({ id: response.job.id, chatId: targetChatId }, 'failed');
      }
    } catch (error) {
      lastError = String(error?.message || 'poll failed');
      nextPollAt = Date.now() + pollBackoffMs;
      pollBackoffMs = Math.min(60000, pollBackoffMs * 2);
    } finally {
      pollBusy = false;
    }
  }
  async function pulse() {
    if (pulseBusy) return;
    pulseBusy = true;
    try {
    const current = getChatId();
    if (current !== chatId) {
      if (activeJob) {
        await acknowledge(activeJob, 'uncertain');
        activeJob = null;
      }
      chatId = current;
      registered = false;
      remoteEnabled = false;
      exportAllowed = false;
      lastHeartbeat = 0;
      lastHeartbeatStatus = '';
      lastStateRefresh = 0;
      nextPollAt = 0;
      pollBackoffMs = 2000;
    }
    if (!chatId) return;
    if (Date.now() - lastStateRefresh > 5000) {
      lastStateRefresh = Date.now();
      try { await refreshState(); } catch (error) {
        lastError = String(error?.message || 'state refresh failed');
      }
    }
    if (!registered) return;
    await heartbeat();
    if (remoteEnabled && safeToReceive() && !activeJob) void pollOnce();
    } finally {
      pulseBusy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'getChatInfo') {
      sendResponse({
        chatId: getChatId(),
        title: document.title || 'ChatGPT tab',
        alias: aliasFromTitle()
      });
      return false;
    }
    return false;
  });

  setInterval(() => { void pulse(); }, 1500);
  void pulse();
})();
