const $ = id => document.getElementById(id);
let activeTab = null;
let activeChat = null;
let currentState = { registered: false, remoteEnabled: false, exportAllowed: false };

async function background(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'background request failed');
  return response.result;
}
async function loadActiveChat() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  if (!activeTab?.id || !String(activeTab.url || '').startsWith('https://chatgpt.com/')) {
    activeChat = null;
    currentState = { registered: false, remoteEnabled: false, exportAllowed: false };
    $('chatTitle').textContent = 'Open a saved ChatGPT conversation';
    $('chatId').textContent = '';
    $('register').disabled = true;
    $('remoteEnabled').checked = false;
    $('remoteEnabled').disabled = true;
    $('registrationState').textContent = 'Not registered';
    return;
  }
  try {
    activeChat = await chrome.tabs.sendMessage(activeTab.id, { type: 'getChatInfo' });
  } catch (_) {
    activeChat = null;
  }
  if (!activeChat?.chatId) {
    currentState = { registered: false, remoteEnabled: false, exportAllowed: false };
    $('chatTitle').textContent = 'Save or open a ChatGPT conversation first';
    $('chatId').textContent = '';
    $('register').disabled = true;
    $('remoteEnabled').checked = false;
    $('remoteEnabled').disabled = true;
    $('registrationState').textContent = 'Not registered';
    return;
  }
  $('chatTitle').textContent = activeChat.title || 'ChatGPT conversation';
  $('chatId').textContent = 'Conversation ID: ' + activeChat.chatId;
  await refreshState();
}
async function refreshState() {
  if (!activeChat?.chatId) return;
  currentState = await background({ type: 'popup.state', chatId: activeChat.chatId });
  $('register').disabled = Boolean(currentState.registered);
  $('register').textContent = currentState.registered ? 'Already registered' : 'Register this chat';
  $('exportAllowed').checked = currentState.registered
    ? currentState.exportAllowed === true : $('exportAllowed').checked;
  $('exportAllowed').disabled = Boolean(currentState.registered);
  $('remoteEnabled').checked = currentState.remoteEnabled === true;
  $('remoteEnabled').disabled = !currentState.registered;
  $('registrationState').textContent = currentState.registered ? 'Registered' : 'Not registered';
}
async function refresh() {
  try {
    $('status').textContent = 'Checking…';
    await loadActiveChat();
    $('status').textContent = currentState.registered
      ? (currentState.remoteEnabled ? 'Remote tasks enabled' : 'Chat registered; remote tasks off')
      : 'Not connected';
  } catch (error) {
    $('status').textContent = String(error?.message || 'Connection failed');
  }
}
$('origin').textContent = 'chrome-extension://' + chrome.runtime.id;
$('copy').addEventListener('click', async () => {
  const value = 'chrome-extension://' + chrome.runtime.id;
  try {
    await navigator.clipboard.writeText(value);
    $('status').textContent = 'Extension origin copied';
  } catch (_) {
    $('status').textContent = 'Copy unavailable; select the origin text manually';
  }
});
$('register').addEventListener('click', async () => {
  if (!activeChat?.chatId) return;
  $('register').disabled = true;
  $('status').textContent = 'Registering…';
  try {
    const result = await background({
      type: 'popup.register',
      chatId: activeChat.chatId,
      alias: activeChat.alias || activeChat.title || 'ChatGPT tab',
      exportAllowed: $('exportAllowed').checked
    });
    $('status').textContent = result.alreadyRegistered
      ? 'This chat is already registered'
      : 'Chat registered. Remote tasks remain off until enabled.';
    await refreshState();
  } catch (error) {
    $('status').textContent = String(error?.message || 'Registration failed') +
      ' — check DISPATCHER_EXTENSION_ORIGIN and restart the local server.';
    $('register').disabled = false;
  }
});
$('remoteEnabled').addEventListener('change', async () => {
  if (!activeChat?.chatId || !currentState.registered) return;
  $('remoteEnabled').disabled = true;
  try {
    const result = await background({
      type: 'popup.setRemote',
      chatId: activeChat.chatId,
      enabled: $('remoteEnabled').checked
    });
    $('status').textContent = result.remoteEnabled
      ? 'Remote tasks enabled for this chat'
      : 'Remote tasks disabled for this chat';
    await refreshState();
  } catch (error) {
    $('status').textContent = String(error?.message || 'Could not update remote setting');
    $('remoteEnabled').checked = currentState.remoteEnabled === true;
    $('remoteEnabled').disabled = !currentState.registered;
  }
});
$('refresh').addEventListener('click', refresh);
refresh();
