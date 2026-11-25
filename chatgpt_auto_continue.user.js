// ==UserScript==
// @name         ChatGPT Auto Continue + Floating Panel
// @namespace    http://tampermonkey.net/
// @version      1.32
// @updateURL    https://raw.githubusercontent.com/xandrx/chatgpt-auto-continue/main/chatgpt_auto_continue.user.js
// @downloadURL  https://raw.githubusercontent.com/xandrx/chatgpt-auto-continue/main/chatgpt_auto_continue.user.js
// @description  Auto-continue with conversation activity detection, submission verification, sound alerts and statistics
// @description:ru Автопродолжение с проверкой активности диалога, подтверждением отправки, звуками и статистикой
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const INSTANCE_KEY = 'cgpt_autocont_active_instance_v1';
    const PANEL_ID = 'cgpt-autocont-panel';
    const VIEWPORT_MARGIN = 12;

    if (window.__cgptAutoContCleanup) {
        try {
            window.__cgptAutoContCleanup();
        } catch (_) {}
    }
    document.getElementById(PANEL_ID)?.remove();

    try {
        sessionStorage.setItem(INSTANCE_KEY, INSTANCE_ID);
    } catch (_) {}

    const DEFAULT_STOP_WORD = 'STOP_IT';
    const CHECK_INTERVAL_MS = 800;
    const TAB_READ_DELAY_MS = 3000;
    const TAB_ACTIVITY_WINDOW_MS = 2400;
    const SUBMIT_DELAY_MS = 450;
    // Do not treat a quiet response as finished: thinking/tool calls can take minutes.
    const SEND_READY_TIMEOUT_MS = 5000;
    const SEND_CONFIRM_TIMEOUT_MS = 15000;
    const RESPONSE_WAIT_TIMEOUT_MS = 90000;
    // The sidebar is a stronger positive indicator than the temporary Send button.
    // A response is complete only after ALL known activity signals stay quiet.
    const COMPLETION_STABLE_MS = 5000;
    const COMPLETION_STABLE_NO_SIDEBAR_MS = 10000;
    // A stale assistant aria-busy flag must not block the panel forever when
    // the sidebar explicitly says idle and the composer is ready.
    const UNCORROBORATED_BUSY_STALE_MS = 45000;
    const UNCERTAIN_BUSY_STALE_MS = 120000;
    const SIDEBAR_STALE_MS = 30000;

    const STORAGE_DEFAULTS_KEY = 'cgpt_autocont_defaults_v4';
    const STORAGE_CHATS_KEY = 'cgpt_autocont_chats_v4';
    // Runtime state belongs to this browser tab, not to every tab of chatgpt.com.
    const STORAGE_TAB_CHATS_KEY = 'cgpt_autocont_tab_chats_v1';
    const STORAGE_POS_KEY = 'cgpt_autocont_pos_v1';
    const STORAGE_SOUND_KEY = 'cgpt_autocont_sound_v1';
    const STORAGE_AUTOSCROLL_KEY = 'cgpt_autocont_autoscroll_v1';
    const STORAGE_COLLAPSED_KEY = 'cgpt_autocont_collapsed_v1';

    const STORAGE_LANGUAGE_KEY = 'cgpt_autocont_language_v1';
    const UI_EN = Object.freeze({
        "Продолжай": "Continue",
        "Если дальнейших улучшений нет, напиши {STOP_WORD}. Если не рекомендовано для торговли, также напиши {STOP_WORD}": "If there are no further improvements, write {STOP_WORD}. If it is not recommended for trading, also write {STOP_WORD}.",
        "Нет попыток": "No attempts",
        "Лимит ChatGPT — выкл": "ChatGPT limit — off",
        "Ошибка ChatGPT — выкл": "ChatGPT error — off",
        "ГОТОВО": "DONE",
        "СТОП": "STOP",
        "ЛИМИТ": "LIMIT",
        "ПРОВЕРКА": "CHECK",
        "ОШИБКА": "ERROR",
        "Развернуть виджет": "Expand widget",
        "Свернуть виджет в компактный размер": "Collapse widget",
        "Автоскролл включён (нажмите, чтобы выключить)": "Auto-scroll on (click to disable)",
        "Автоскролл выключен (нажмите, чтобы включить)": "Auto-scroll off (click to enable)",
        "Звук включён (нажмите, чтобы выключить)": "Sound on (click to disable)",
        "Звук выключен (нажмите, чтобы включить)": "Sound off (click to enable)",
        "откл": "off",
        "Продолжений": "Continuations",
        "Стоп": "Stop",
        "Прошло": "Elapsed",
        "Среднее": "Average",
        "Вкл": "On",
        "Выкл": "Off",
        "Выключено": "Disabled",
        "Генерация...": "Generating...",
        "Ожидание": "Idle",
        "Клик: ": "Click: ",
        "Стоп-слово": "Stop word",
        "Отправка уже выполняется": "Submission already in progress",
        "Ожидание предыдущего ответа": "Waiting for previous reply",
        "Генерация ещё активна": "Generation still active",
        "Поле ввода не найдено": "Composer not found",
        "Черновик не пуст — отправка отменена": "Draft not empty — submission canceled",
        "Повтор: готовый черновик": "Retry: draft ready",
        "Заполнение редактора": "Filling composer",
        "Не удалось заполнить поле ввода": "Could not fill composer",
        "Черновик готов": "Draft ready",
        "Отправка...": "Sending...",
        "Генерация возобновилась": "Generation resumed",
        "Черновик изменён — отправка отменена": "Draft changed — submission canceled",
        "Отправка подтверждена": "Submission confirmed",
        "Ожидание ответа...": "Waiting for reply...",
        "Клик без подтверждения": "Click not confirmed",
        "Отправка не подтверждена — проверьте черновик": "Submission not confirmed — check draft",
        "Кнопка отправки недоступна": "Send button unavailable",
        "Ошибка отправки: ": "Submission error: ",
        "Перетащить панель": "Drag widget",
        "Число продолжений в текущем чате": "Continuations in this conversation",
        "Отправить промпт сейчас": "Send prompt now",
        "Промпт для продолжения...": "Continuation prompt...",
        "Базовый промпт (поддерживает несколько строк; к нему добавится стоп-промпт)": "Base prompt (multiline; the stop prompt is appended)",
        "Сбросить промпт, стоп-промпт и стоп-слово": "Reset prompt, stop prompt and stop word",
        "Стоп-промпт (поддерживает {STOP_WORD}):": "Stop prompt (supports {STOP_WORD}):",
        "Правило остановки...": "Stop condition...",
        "Инструкция об условиях вывода стоп-слова (сохраняется для каждого чата)": "Instructions for when to output the stop word (saved per conversation)",
        "Стоп-слово:": "Stop word:",
        "Если агент выведет это слово, сработает звуковой сигнал и автопродолжение выключится": "If the agent outputs this word, a sound plays and auto-continue is disabled",
        "Генерация — диагностика": "Generation — diagnostics",
        "Отправка: ": "Submission: ",
        "Sidebar устарел: ": "Sidebar stale: ",
        "Sidebar без подтверждения: ": "Unconfirmed sidebar: ",
        "Недавнее изменение ответа: ": "Recent response activity: ",
        "Запрос без ответа: ": "Unanswered request: ",
        "Кнопка Stop: ": "Stop button: ",
        "Атрибут busy: ": "Busy attribute: ",
        "Busy устарел: ": "Busy stale: ",
        "Отправка доступна: ": "Send available: ",
        "Редактор доступен: ": "Composer editable: ",
        "да": "yes",
        "нет": "no",
        "Зависший Sidebar · проверка": "Stale sidebar · check",
        "Зависший busy · проверка": "Stale busy · check",
        "Генерация · чат": "Generating · chat",
        "Генерация · Stop": "Generating · Stop",
        "Генерация · текст": "Generating · text",
        "Генерация · запрос": "Generating · request",
        "Генерация · busy": "Generating · busy",
        "Нет ответа — выкл": "No reply — off",
        "Язык интерфейса": "Interface language"
    });
    let language = loadJSON(STORAGE_LANGUAGE_KEY, 'en') === 'ru' ? 'ru' : 'en';
    let refreshLanguageUI = null;

    function tr(text) {
        if (language === 'ru' || typeof text !== 'string') return text;
        if (Object.prototype.hasOwnProperty.call(UI_EN, text)) return UI_EN[text];
        for (const prefix of ['Клик: ', 'Ошибка отправки: ']) {
            if (text.startsWith(prefix)) return UI_EN[prefix] + text.slice(prefix.length);
        }
        const completion = text.match(/^Проверка завершения: (\d+)с$/u);
        return completion ? 'Checking completion: ' + completion[1] + 's' : text;
    }

    function setLanguage(next, persist = true) {
        const normalized = next === 'ru' ? 'ru' : 'en';
        if (language === normalized) return;
        language = normalized;
        if (persist) saveJSON(STORAGE_LANGUAGE_KEY, language);
        refreshLanguageUI?.();
    }

    function defaultContinueText() {
        return tr('Продолжай');
    }

    function defaultStopPrompt() {
        return tr('Если дальнейших улучшений нет, напиши {STOP_WORD}. Если не рекомендовано для торговли, также напиши {STOP_WORD}');
    }

    let disposed = false;
    let currentChatKey = null;
    // A newly opened tab must not inherit an old global enabled flag.
    let enabled = false;
    let soundEnabled = loadBoolPref(STORAGE_SOUND_KEY, true);
    let autoScrollEnabled = loadBoolPref(STORAGE_AUTOSCROLL_KEY, true);
    let collapsed = loadBoolPref(STORAGE_COLLAPSED_KEY, false);
    let continueText = defaultContinueText();
    let stopWord = DEFAULT_STOP_WORD;
    let stopPrompt = defaultStopPrompt();
    let wasGenerating = false;
    let hasCompletedOnce = false;
    let stopNotifiedForCurrentReply = false;
    let isSubmitting = false;
    let awaitingReply = false;
    let submittedAtMs = 0;
    let submittedAssistantCount = 0;
    let pendingSubmitTimerId = null;
    let pendingSubmitToken = 0;
    let pendingOwnedDraft = null;
    let lastSendStage = 'Нет попыток';
    let completionCandidateSinceMs = 0;
    let weakBusySinceMs = 0;
    let weakBusyTextFingerprint = null;
    let sidebarOnlySinceMs = null;
    let sidebarOnlyFingerprint = null;
    let assistantActivityFingerprint = null;
    let assistantActivityAt = null;
    let manualBlockUntil = 0;
    let manualBlockReason = '';
    let userScrolledAway = false;
    let lastScrollTop = 0;

    // Состояние индикатора вкладки: 'working' (оранжевый), 'done' (зелёный), null (обычный)
    let tabIndicatorMode = null;
    let basePageTitle = null;
    let originalFaviconHrefs = [];
    let generatedFaviconLink = null;
    let titleObserver = null;
    let isUpdatingTitle = false;
    let tabRequestStartedAtMs = null;
    let tabLastActivityAtMs = null;
    let tabLastAssistantSnapshot = null;
    let tabReadFocusSinceMs = null;
    let tabNotice = null;
    let lastFaviconKey = null;
    const badgeFaviconCache = new Map();

    let sessionCount = 0;
    let enabledSinceMs = null;
    let cycleStartMs = null;
    let cycleDurationsMs = [];

    let audioCtx = null;
    let panelEl = null;
    let bodyContainerEl = null;
    let statusBadgeEl = null;
    let compactCountEl = null;
    let collapseBtnEl = null;
    let scrollBtnEl = null;
    let soundBtnEl = null;
    let sendNowBtnEl = null;
    let toggleBtnEl = null;
    let promptInputEl = null;
    let stopPromptInputEl = null;
    let stopWordInputEl = null;
    let statsEl = null;

    function stripTabPrefix(title) {
        return String(title || '')
            .replace(/^(?:(?:🟠|🟢|\?\?)\s*)?\[(?:РАБОТАЕТ|ГОТОВО|СТОП|ЛИМИТ|ПРОВЕРКА|ОШИБКА|WORKING|DONE|STOP|LIMIT|CHECK|ERROR|\d{2,}:\d{2}(?::\d{2})?)\]\s*/u, '')
            .replace(/^(?:🟠|🟢)\s*/u, '')
            .trim();
    }

    function formatTabElapsed(ms) {
        const seconds = Math.floor(Math.max(0, ms) / 1000);
        const hours = Math.floor(seconds / 3600);
        const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
        const ss = String(seconds % 60).padStart(2, '0');
        return hours ? String(hours).padStart(2, '0') + ':' + mm + ':' + ss : mm + ':' + ss;
    }

    function sampleTabAssistantActivity(active, now = Date.now()) {
        const turns = getAssistantElements();
        const last = turns[turns.length - 1];
        const next = {
            count: turns.length,
            id: last?.getAttribute('data-message-id') ||
                last?.getAttribute('data-dil-message-id') || '',
            text: last?.textContent || ''
        };
        const previous = tabLastAssistantSnapshot;
        // Keep an idle baseline; spinner animations alone never count as output.
        if (active && previous &&
            (next.count > previous.count ||
             (next.id && next.id !== previous.id) ||
             next.text !== previous.text) && next.text.trim()) {
            tabLastActivityAtMs = now;
        }
        tabLastAssistantSnapshot = next;
    }

    function resetTabReadFocus() {
        tabReadFocusSinceMs = null;
    }

    function acknowledgeTabCompletion(now = Date.now()) {
        if (!['done', 'stopped', 'limit', 'warning', 'error'].includes(tabIndicatorMode) ||
            document.visibilityState !== 'visible' || !document.hasFocus()) {
            resetTabReadFocus();
            return false;
        }
        if (tabReadFocusSinceMs === null) tabReadFocusSinceMs = now;
        if (now - tabReadFocusSinceMs < TAB_READ_DELAY_MS) return false;
        hasCompletedOnce = false; // Don't recreate the badge on the next tick.
        if (tabNotice) tabNotice.acknowledged = true;
        setTabIndicator(null);
        return true;
    }

    // Notice identity prevents persistent DOM signals from rearming a read badge.
    function showTabNotice(mode, reason) {
        const key = mode + ':' + reason;
        hasCompletedOnce = false;
        if (!tabNotice || tabNotice.key !== key) {
            tabNotice = { key, mode, reason, acknowledged: false };
            setTabIndicator(mode);
        } else if (!tabNotice.acknowledged) {
            setTabIndicator(mode);
        }
        setStatus(reason, 'stop');
    }

    function clearTabNotice() {
        tabNotice = null;
    }

    function pauseForUiFailure(mode, reason) {
        cancelPendingSend();
        awaitingReply = false;
        wasGenerating = false;
        completionCandidateSinceMs = 0;
        if (enabled) {
            enabled = false;
            enabledSinceMs = null;
            persistCurrentSettings(true);
            updateToggleUI();
        }
        showTabNotice(mode, reason);
        acknowledgeTabCompletion();
    }

    // Only explicit application alerts; never infer quota/error from ordinary
    // assistant prose. These UI phrases/selectors are best-effort, not an API.
    function classifyUiFailure(text) {
        const t = normalizeText(text);
        if (!t) return null;
        if (/(?:you(?:'|’| have )?ve? (?:reached|hit)|you have (?:reached|hit)|you (?:reached|hit))[^.!?]{0,100}(?:limit|quota)|(?:rate|usage|message) limit (?:reached|exceeded)|too many requests|(?:достиг(?:ли|нут)?|исчерпан(?:о)?)\s+(?:[^.!?]{0,50}\s+)?лимит|лимит[^.!?]{0,60}(?:исчерпан|достигнут)|слишком много запросов/iu.test(t)) {
            return {mode:'limit', reason:'Лимит ChatGPT — выкл'};
        }
        if (/something went wrong|error (?:while |in )?generating (?:a |the )?response|network error|network connection lost|что-то пошло не так|ошибка (?:при )?генерации|ошибка сети|сетевая ошибка/iu.test(t)) {
            return {mode:'error', reason:'Ошибка ChatGPT — выкл'};
        }
        return null;
    }

    function getExplicitUiFailure() {
        const main = document.querySelector('main');
        if (!main) return null;
        const turns = getAssistantElements();
        const latest = turns[turns.length - 1];
        for (const el of main.querySelectorAll('[role="alert"], [data-testid="error-message"], [data-testid="rate-limit-message"]')) {
            if (!el.isConnected || el.closest('#' + PANEL_ID + ', [hidden], [aria-hidden="true"], [inert]') ||
                !el.getClientRects().length) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') continue;
            const message = el.closest('[data-message-author-role]');
            if (message && (!latest || (message !== latest && !message.contains(latest) && !latest.contains(message)))) continue;
            const failure = classifyUiFailure(el.innerText || el.textContent || '');
            if (failure) return failure;
        }
        return null;
    }

    function captureOriginalFavicons() {
        const links = [...document.querySelectorAll('link[rel~="icon"]')].filter(
            (el) => el.dataset.cgptTabBadge !== 'true'
        );
        originalFaviconHrefs = links.map((el) => ({
            el,
            href: el.getAttribute('href')
        }));
    }

    function restoreOriginalFavicons() {
        if (generatedFaviconLink && generatedFaviconLink.parentNode) {
            generatedFaviconLink.parentNode.removeChild(generatedFaviconLink);
        }
        generatedFaviconLink = null;

        for (const item of originalFaviconHrefs) {
            if (item.el && item.el.isConnected && item.href !== null) {
                item.el.setAttribute('href', item.href);
            }
        }
    }

    function buildBadgeFaviconDataUrl(mode, phase = -1) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;

            const isWorking = mode === 'working';
            const colors = {
                working: ['#ea580c', '#fdba74'],
                done: ['#16a34a', '#86efac'],
                stopped: ['#ca8a04', '#fde047'],
                limit: ['#ca8a04', '#fde047'],
                warning: ['#ca8a04', '#fde047'],
                error: ['#dc2626', '#fca5a5']
            };
            const [bgColor, ringColor] = colors[mode] || colors.done;

            ctx.beginPath();
            ctx.arc(32, 32, 28, 0, Math.PI * 2);
            ctx.fillStyle = bgColor;
            ctx.fill();

            ctx.lineWidth = 4;
            ctx.strokeStyle = ringColor;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            if (isWorking) {
                const dots = [20, 32, 44];
                for (let i = 0; i < dots.length; i++) {
                    ctx.beginPath();
                    ctx.fillStyle = phase < 0 || i === phase ? '#ffffff' : '#fdba74';
                    ctx.arc(dots[i], 32, phase === i ? 6.2 : 4.5, 0, Math.PI * 2);
                    ctx.fill();
                }
            } else if (mode === 'stopped') {
                ctx.fillRect(21, 21, 22, 22);
            } else if (mode === 'limit' || mode === 'warning' || mode === 'error') {
                ctx.beginPath();
                ctx.moveTo(32, 17);
                ctx.lineTo(32, 33);
                ctx.lineWidth = 7;
                ctx.lineCap = 'round';
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(32, 44, 3.7, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.moveTo(19, 33);
                ctx.lineTo(28, 42);
                ctx.lineTo(46, 23);
                ctx.lineWidth = 6.5;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
            }

            return canvas.toDataURL('image/png');
        } catch (_) {
            return null;
        }
    }

    function applyFaviconMode(mode) {
        if (!mode) {
            if (lastFaviconKey !== null) restoreOriginalFavicons();
            lastFaviconKey = null;
            return;
        }

        const now = Date.now();
        const recent = mode === 'working' && tabLastActivityAtMs !== null &&
            now - tabLastActivityAtMs < TAB_ACTIVITY_WINDOW_MS;
        const phase = recent ? Math.floor(now / CHECK_INTERVAL_MS) % 3 : -1;
        const key = mode + ':' + phase;
        if (lastFaviconKey === key && generatedFaviconLink?.isConnected) return;

        if (originalFaviconHrefs.length === 0) captureOriginalFavicons();

        let dataUrl = badgeFaviconCache.get(key);
        if (!dataUrl) {
            dataUrl = buildBadgeFaviconDataUrl(mode, phase);
            if (!dataUrl) return;
            badgeFaviconCache.set(key, dataUrl);
        }
        lastFaviconKey = key;

        for (const item of originalFaviconHrefs) {
            if (item.el && item.el.isConnected) {
                item.el.setAttribute('href', dataUrl);
            }
        }

        if (!generatedFaviconLink || !generatedFaviconLink.isConnected) {
            generatedFaviconLink = document.createElement('link');
            generatedFaviconLink.rel = 'icon';
            generatedFaviconLink.type = 'image/png';
            generatedFaviconLink.dataset.cgptTabBadge = 'true';
            document.head.appendChild(generatedFaviconLink);
        }
        generatedFaviconLink.href = dataUrl;
    }

    function applyTitleMode(mode) {
        const cleanCurrent = stripTabPrefix(document.title);
        if (!basePageTitle && cleanCurrent) {
            basePageTitle = cleanCurrent;
        } else if (cleanCurrent && cleanCurrent !== basePageTitle) {
            basePageTitle = cleanCurrent;
        }

        const targetBase = basePageTitle || cleanCurrent || 'ChatGPT';
        let nextTitle = targetBase;

        if (mode === 'working') {
            nextTitle = `[${formatTabElapsed(Date.now() - (tabRequestStartedAtMs ?? Date.now()))}] ${targetBase}`;
        } else if (mode === 'done') {
            nextTitle = `[${tr('ГОТОВО')}] ${targetBase}`;
        } else if (['stopped', 'limit', 'warning', 'error'].includes(mode)) {
            const labels = {stopped:'СТОП', limit:'ЛИМИТ', warning:'ПРОВЕРКА', error:'ОШИБКА'};
            nextTitle = `[${tr(labels[mode])}] ${targetBase}`;
        }

        if (document.title !== nextTitle) {
            isUpdatingTitle = true;
            document.title = nextTitle;
            setTimeout(() => {
                isUpdatingTitle = false;
            }, 0);
        }
    }

    function setTabIndicator(mode) {
        if (disposed) return;
        const normalizedMode = ['working', 'done', 'stopped', 'limit', 'warning', 'error'].includes(mode) ? mode : null;
        if (tabIndicatorMode !== normalizedMode) {
            if (normalizedMode === 'working') clearTabNotice();
            tabRequestStartedAtMs = normalizedMode === 'working' ? Date.now() : null;
            tabLastActivityAtMs = null;
            resetTabReadFocus();
            tabIndicatorMode = normalizedMode;
        }
        applyTitleMode(normalizedMode);
        applyFaviconMode(normalizedMode);
    }

    function startTitleGuard() {
        const titleEl = document.querySelector('title');
        if (!titleEl || titleObserver) return;

        titleObserver = new MutationObserver(() => {
            if (disposed || isUpdatingTitle || !tabIndicatorMode) return;
            applyTitleMode(tabIndicatorMode);
        });

        titleObserver.observe(titleEl, {
            childList: true,
            characterData: true,
            subtree: true
        });
    }

    function loadBoolPref(key, defaultVal) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? Boolean(defaultVal) : raw === 'true';
        } catch (_) {
            return Boolean(defaultVal);
        }
    }

    function saveBoolPref(key, val) {
        try {
            localStorage.setItem(key, String(Boolean(val)));
        } catch (_) {}
    }

    function getViewportBounds() {
        const vv = window.visualViewport;
        const width = vv ? vv.width : window.innerWidth;
        const height = vv ? vv.height : window.innerHeight;
        return {
            width: Math.max(200, Number(width) || window.innerWidth || 800),
            height: Math.max(200, Number(height) || window.innerHeight || 600)
        };
    }

    function clampPosition(left, top, panelWidth, panelHeight) {
        const vp = getViewportBounds();
        const pw = panelWidth || (panelEl ? panelEl.offsetWidth : 312) || 312;
        const ph = panelHeight || (panelEl ? panelEl.offsetHeight : 44) || 44;

        const maxLeft = Math.max(VIEWPORT_MARGIN, vp.width - pw - VIEWPORT_MARGIN);
        const maxTop = Math.max(VIEWPORT_MARGIN, vp.height - ph - VIEWPORT_MARGIN);

        const clampedLeft = Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft);
        const clampedTop = Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop);

        return {
            left: Math.round(clampedLeft),
            top: Math.round(clampedTop)
        };
    }

    function applyPanelPosition(left, top, persist = false) {
        if (!panelEl) return;
        const pos = clampPosition(left, top, panelEl.offsetWidth, panelEl.offsetHeight);
        panelEl.style.left = `${pos.left}px`;
        panelEl.style.top = `${pos.top}px`;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
        if (persist) {
            saveJSON(STORAGE_POS_KEY, pos);
        }
    }

    function clampPanelToViewport(persist = false) {
        if (!panelEl || disposed) return;
        const rect = panelEl.getBoundingClientRect();
        applyPanelPosition(rect.left, rect.top, persist);
    }

    function updateCollapsedUI() {
        if (!panelEl || !bodyContainerEl || !collapseBtnEl) return;

        bodyContainerEl.style.display = collapsed ? 'none' : 'flex';
        if (scrollBtnEl) scrollBtnEl.style.display = collapsed ? 'none' : 'inline-flex';
        if (soundBtnEl) soundBtnEl.style.display = collapsed ? 'none' : 'inline-flex';
        if (sendNowBtnEl) sendNowBtnEl.style.display = collapsed ? 'none' : 'inline-flex';
        if (compactCountEl) {
            compactCountEl.style.display = collapsed ? 'inline-block' : 'none';
            compactCountEl.textContent = `${sessionCount}x`;
        }

        panelEl.style.width = collapsed ? 'auto' : '312px';
        panelEl.style.padding = collapsed ? '6px 8px' : '9px 11px';
        panelEl.style.gap = collapsed ? '0px' : '8px';

        collapseBtnEl.textContent = collapsed ? '▣' : '−';
        collapseBtnEl.title = tr(collapsed ? 'Развернуть виджет' : 'Свернуть виджет в компактный размер');

        requestAnimationFrame(() => {
            clampPanelToViewport(false);
        });
    }

    function ensureAudioContext() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!audioCtx || audioCtx.state === 'closed') {
            audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        return audioCtx;
    }

    function playTickSound() {
        if (!soundEnabled) return;
        try {
            const ctx = ensureAudioContext();
            if (!ctx) return;

            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(1150, now);
            osc.frequency.exponentialRampToValueAtTime(380, now + 0.035);

            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.18, now + 0.004);
            gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.04);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(now);
            osc.stop(now + 0.045);
        } catch (_) {}
    }

    function playStopBeepSound() {
        if (!soundEnabled) return;
        try {
            const ctx = ensureAudioContext();
            if (!ctx) return;

            const now = ctx.currentTime;
            const pulses = [
                { offset: 0, dur: 0.14, freq: 880 },
                { offset: 0.19, dur: 0.22, freq: 660 }
            ];

            for (const p of pulses) {
                const start = now + p.offset;
                const end = start + p.dur;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(p.freq, start);

                gain.gain.setValueAtTime(0.001, start);
                gain.gain.linearRampToValueAtTime(0.22, start + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.001, end);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(start);
                osc.stop(end + 0.01);
            }
        } catch (_) {}
    }

    function getScrollContainer() {
        const footer = document.querySelector('[data-thread-scroll-footer="true"]');
        if (footer) {
            let parent = footer.parentElement;
            while (parent && parent !== document.body && parent !== document.documentElement) {
                const style = window.getComputedStyle(parent);
                const overflowY = style.overflowY;
                if (
                    (overflowY === 'auto' || overflowY === 'scroll') &&
                    parent.scrollHeight > parent.clientHeight + 40
                ) {
                    return parent;
                }
                parent = parent.parentElement;
            }
        }

        const candidates = [
            document.querySelector('[data-testid="conversation-turn-list"]')?.parentElement,
            document.querySelector('main [class*="overflow-y-auto"]'),
            document.querySelector('main [class*="overflow-y-scroll"]'),
            document.scrollingElement
        ].filter(Boolean);

        for (const el of candidates) {
            if (el.scrollHeight > el.clientHeight + 40) {
                return el;
            }
        }
        return document.scrollingElement || document.documentElement;
    }

    function getScrollDownButton() {
        return (
            document.querySelector('button.group\\/scroll-to-bottom') ||
            document.querySelector('button[aria-label="Прокрутить вниз"]') ||
            document.querySelector('button[aria-label*="Scroll down"]')
        );
    }

    function performAutoScroll() {
        if (!autoScrollEnabled || userScrolledAway || disposed) return;

        const scrollBtn = getScrollDownButton();
        if (scrollBtn) {
            const rect = scrollBtn.getBoundingClientRect();
            const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                scrollBtn.getAttribute('aria-hidden') !== 'true' &&
                window.getComputedStyle(scrollBtn).opacity !== '0';
            if (isVisible) {
                scrollBtn.click();
                return;
            }
        }

        const container = getScrollContainer();
        if (container) {
            const targetTop = container.scrollHeight - container.clientHeight;
            if (targetTop > container.scrollTop + 4) {
                container.scrollTop = targetTop;
                lastScrollTop = container.scrollTop;
            }
        }
    }

    function getConversationKey() {
        const path = window.location.pathname || '/';
        const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
            return `chat:${match[1]}`;
        }
        return `route:${path}`;
    }

    function loadJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    function formatDuration(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-';
        const totalSec = Math.floor(ms / 1000);
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;

        if (hours > 0) {
            return `${hours}${language === 'ru' ? 'ч' : 'h'} ${String(minutes).padStart(2, '0')}${language === 'ru' ? 'м' : 'm'} ${String(seconds).padStart(2, '0')}${language === 'ru' ? 'с' : 's'}`;
        }
        if (minutes > 0) {
            return `${minutes}${language === 'ru' ? 'м' : 'm'} ${String(seconds).padStart(2, '0')}${language === 'ru' ? 'с' : 's'}`;
        }
        return `${seconds}${language === 'ru' ? 'с' : 's'}`;
    }

    function resetSessionStats(keepEnabledStart) {
        sessionCount = 0;
        cycleDurationsMs = [];
        cycleStartMs = Date.now();
        enabledSinceMs = keepEnabledStart ? Date.now() : null;
    }

    function loadTabChatState(chatKey) {
        try {
            const all = JSON.parse(sessionStorage.getItem(STORAGE_TAB_CHATS_KEY) || '{}');
            const saved = all && typeof all === 'object' ? all[chatKey] : null;
            if (!saved || typeof saved !== 'object') return { enabled: false, stats: null };
            return {
                enabled: saved.enabled === true,
                stats: saved.stats && typeof saved.stats === 'object' ? saved.stats : null
            };
        } catch (_) {
            return { enabled: false, stats: null };
        }
    }

    function saveTabChatState(chatKey, includeStats = true) {
        if (!chatKey) return;
        try {
            const raw = JSON.parse(sessionStorage.getItem(STORAGE_TAB_CHATS_KEY) || '{}');
            const all = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
            const previous = all[chatKey] && typeof all[chatKey] === 'object'
                ? all[chatKey] : {};
            all[chatKey] = {
                enabled: Boolean(enabled),
                stats: includeStats || !previous.stats
                    ? { sessionCount, enabledSinceMs, cycleDurationsMs: [...cycleDurationsMs] }
                    : previous.stats
            };
            sessionStorage.setItem(STORAGE_TAB_CHATS_KEY, JSON.stringify(all));
        } catch (_) {}
    }

    function getChatConfig(chatKey) {
        const defaults = loadJSON(STORAGE_DEFAULTS_KEY, {
            prompt: defaultContinueText(),
            stopPrompt: defaultStopPrompt(),
            stopWord: DEFAULT_STOP_WORD
        });
        const chats = loadJSON(STORAGE_CHATS_KEY, {});
        const saved = chats[chatKey] || {};

        // Shared storage contains prompt preferences only. In particular, never
        // consult legacy .enabled or .stats: they belong to a different tab.
        return {
            prompt:
                typeof saved.prompt === 'string' && saved.prompt.trim().length > 0
                    ? saved.prompt
                    : (typeof defaults.prompt === 'string' && defaults.prompt.trim().length > 0
                        ? defaults.prompt
                        : defaultContinueText()),
            stopPrompt:
                typeof saved.stopPrompt === 'string'
                    ? saved.stopPrompt
                    : (typeof defaults.stopPrompt === 'string'
                        ? defaults.stopPrompt
                        : defaultStopPrompt()),
            stopWord:
                typeof saved.stopWord === 'string'
                    ? saved.stopWord.trim()
                    : (typeof defaults.stopWord === 'string'
                        ? defaults.stopWord.trim()
                        : DEFAULT_STOP_WORD)
        };
    }

    function saveChatConfig(chatKey, nextPrompt, nextStopPrompt, nextStopWord) {
        if (!chatKey) return;
        const cleanPrompt = typeof nextPrompt === 'string' && nextPrompt.trim()
            ? nextPrompt : defaultContinueText();
        const cleanStopPrompt = typeof nextStopPrompt === 'string' ? nextStopPrompt : '';
        const cleanStopWord = typeof nextStopWord === 'string' ? nextStopWord.trim() : '';

        const chats = loadJSON(STORAGE_CHATS_KEY, {});
        const previous = chats[chatKey] || {};
        // Remove pre-1.21 enabled/stats values whenever this chat is saved.
        const next = { prompt: cleanPrompt, stopPrompt: cleanStopPrompt, stopWord: cleanStopWord };
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
            chats[chatKey] = next;
            saveJSON(STORAGE_CHATS_KEY, chats);
        }

        const previousDefaults = loadJSON(STORAGE_DEFAULTS_KEY, {});
        if (JSON.stringify(previousDefaults) !== JSON.stringify(next)) {
            // Only prompt defaults are shared across tabs; never publish enabled.
            saveJSON(STORAGE_DEFAULTS_KEY, next);
        }
    }

    function syncStateWithCurrentChat(force = false) {
        const nextKey = getConversationKey();
        if (!force && nextKey === currentChatKey) return;

        // Save the previous chat's per-tab state before SPA navigation.
        if (currentChatKey && currentChatKey !== nextKey) {
            saveTabChatState(currentChatKey);
        }
        currentChatKey = nextKey;
        lastSendStage = 'Нет попыток';
        sidebarOnlySinceMs = null;
        sidebarOnlyFingerprint = null;
        assistantActivityFingerprint = null;
        assistantActivityAt = null;
        manualBlockUntil = 0;
        manualBlockReason = '';
        weakBusySinceMs = 0;
        weakBusyTextFingerprint = null;
        const cfg = getChatConfig(currentChatKey);
        const tabState = loadTabChatState(currentChatKey);
        enabled = tabState.enabled;
        continueText = cfg.prompt;
        stopPrompt = cfg.stopPrompt;
        stopWord = cfg.stopWord;
        wasGenerating = false;
        hasCompletedOnce = false;
        completionCandidateSinceMs = 0;
        stopNotifiedForCurrentReply = false;
        cancelPendingSend();
        awaitingReply = false;
        submittedAtMs = 0;
        submittedAssistantCount = 0;
        userScrolledAway = false;
        basePageTitle = stripTabPrefix(document.title) || null;
        clearTabNotice();
        tabLastAssistantSnapshot = null;
        tabLastActivityAtMs = null;
        tabRequestStartedAtMs = null;
        resetTabReadFocus();
        setTabIndicator(null);

        if (tabState.stats) {
            sessionCount = Number(tabState.stats.sessionCount) || 0;
            enabledSinceMs = enabled && typeof tabState.stats.enabledSinceMs === 'number'
                ? tabState.stats.enabledSinceMs : (enabled ? Date.now() : null);
            cycleDurationsMs = Array.isArray(tabState.stats.cycleDurationsMs)
                ? tabState.stats.cycleDurationsMs : [];
        } else {
            resetSessionStats(enabled);
        }
        cycleStartMs = Date.now();

        if (promptInputEl && document.activeElement !== promptInputEl) {
            promptInputEl.value = continueText;
        }
        if (stopPromptInputEl && document.activeElement !== stopPromptInputEl) {
            stopPromptInputEl.value = stopPrompt;
        }
        if (stopWordInputEl && document.activeElement !== stopWordInputEl) {
            stopWordInputEl.value = stopWord;
        }
        updateScrollUI();
        updateSoundUI();
        updateToggleUI();
        updateStatsUI();
    }

    function getComposerInput() {
        const scope = document.querySelector('[data-composer-layout]') ||
            document.querySelector('[class*="ComposerLayoutRoot"]') ||
            document.querySelector('main') || document;
        return (
            document.querySelector('#prompt-textarea[contenteditable="true"]') ||
            document.querySelector('#prompt-textarea:where(textarea, input)') ||
            scope.querySelector('div.ProseMirror[contenteditable="true"][data-composer-markdown]') ||
            scope.querySelector('div.ProseMirror[contenteditable="true"]') ||
            scope.querySelector('[role="textbox"][contenteditable="true"]') ||
            document.querySelector('div.ProseMirror[contenteditable="true"][data-composer-markdown]')
        );
    }

    function getComposerRoot() {
        const input = getComposerInput();
        return input?.closest('form') || input?.closest('[data-composer-layout]') ||
            input?.closest('fieldset') || document.querySelector('main');
    }

    function getStopButton() {
        const root = getComposerRoot();
        const editor = getComposerInput();
        // The stop control can sit outside the form in the surrounding composer.
        const layout = editor?.closest('[data-composer-layout], [class*="ComposerLayoutRoot"]');
        const explicit = 'button[data-composer-stop="true"], button[data-testid="stop-button"], button[data-testid="composer-stop-button"]';
        const candidates = new Set([
            ...(root?.querySelectorAll('button') || []),
            ...(layout?.querySelectorAll('button') || []),
            ...document.querySelectorAll(explicit),
            ...document.querySelectorAll('button#composer-submit-button, main button[aria-label], main button[title]')
        ]);
        for (const btn of candidates) {
            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            const labels = [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.getAttribute('data-tooltip-content')];
            const isStop = btn.getAttribute('data-composer-stop') === 'true' ||
                testId === 'stop-button' || testId === 'composer-stop-button' ||
                labels.some(label => /^(?:stop(?: generating| generation| response| streaming| reasoning| thinking)?|остановить(?: генерацию| ответ| рассуждение| размышление)?)$/iu.test((label || '').trim()));
            // Reject hidden duplicates and unrelated Stop recording controls.
            if (isStop && isVisibleControl(btn)) return btn;
        }
        return null;
    }

    function getAssistantElements() {
        const byRole = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        if (byRole.length > 0) return byRole;

        const byResponseBody = [...document.querySelectorAll('[data-response-body]')];
        if (byResponseBody.length > 0) return byResponseBody;

        // Never fall back to untyped messages: that may select a user's STOP_IT.
        return [...document.querySelectorAll('[data-dil-message-id][data-message-author-role="assistant"]')];
    }

    function getAssistantStreamingFlag() {
        const turns = getAssistantElements();
        const lastTurn = turns[turns.length - 1] || null;
        if (!lastTurn) return { active: false, lastTurn };
        const selector = '[data-is-streaming="true"], [aria-busy="true"], [data-streaming="true"]';
        // Streaming markers can be placed on a turn wrapper or response body.
        const wrapper = lastTurn.closest('article, [data-testid^="conversation-turn-"]') || lastTurn;
        const active = Boolean(lastTurn.matches(selector) || wrapper.matches(selector) ||
            lastTurn.querySelector(selector) || wrapper.querySelector(selector));
        return { active, lastTurn };
    }

    function hasUnansweredUserTurn() {
        const users = document.querySelectorAll('[data-message-author-role="user"]');
        const user = users[users.length - 1];
        if (!user) return false;
        const assistants = getAssistantElements();
        const assistant = assistants[assistants.length - 1];
        return !assistant || Boolean(user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_PRECEDING);
    }

    // Resolve the sidebar indicator for THIS conversation only. A spinner in a
    // different chat must never block this one. The row can disappear when the
    // sidebar is collapsed or virtualized; that means "unknown", not "idle".
    function isVisibleControl(el) {
        if (!el?.isConnected || !el.getClientRects().length ||
            el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        const rect = el.getBoundingClientRect();
        let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
        let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
        for (let node = el; node; node = node.parentElement) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || style.opacity === '0' ||
                style.contentVisibility === 'hidden') return false;
            if (node === el) continue;
            const bounds = node.getBoundingClientRect();
            if (/hidden|clip|scroll|auto/.test(style.overflowX)) {
                left = Math.max(left, bounds.left);
                right = Math.min(right, bounds.right);
            }
            if (/hidden|clip|scroll|auto/.test(style.overflowY)) {
                top = Math.max(top, bounds.top);
                bottom = Math.min(bottom, bounds.bottom);
            }
        }
        return right > left && bottom > top;
    }

    function getCurrentSidebarGenerationState() {
        const match = getConversationKey().match(/^chat:([a-zA-Z0-9_-]+)$/);
        if (!match) return 'unknown';

        const chatId = match[1];
        const row =
            document.querySelector(`[data-sidebar-archive-chatgpt-id="${chatId}"]`) ||
            document.querySelector(`[data-sidebar-chatgpt-conversation-key="chatgpt:conversation:${chatId}"]`);
        if (!isVisibleControl(row)) return 'unknown';

        const indicator = row.matches('[data-sidebar-indicator]')
            ? row
            : (row.closest('[data-sidebar-indicator]') || row.querySelector('[data-sidebar-indicator]'));

        // The data attribute survives visual changes such as hover that hide
        // the spinner; [data-loading-indicator] is an additional positive hint.
        if (indicator?.getAttribute('data-sidebar-indicator') === 'working' ||
            row.querySelector('[data-loading-indicator]')) {
            return 'working';
        }
        return 'idle';
    }

    function getGenerationSignals() {
        const sidebar = getCurrentSidebarGenerationState();
        const stopButton = Boolean(getStopButton());
        const unansweredUserTurn = hasUnansweredUserTurn();
        const { active: replyFlag, lastTurn } = getAssistantStreamingFlag();
        const send = getSendButton();
        const sendReady = Boolean(send && send.isConnected && !send.disabled &&
            send.getAttribute('aria-disabled') !== 'true');
        // A blank editor usually disables Send. Check the editor itself.
        const editor = getComposerInput();
        const composerEditable = Boolean(editor && editor.isConnected &&
            !editor.disabled && editor.getAttribute('aria-disabled') !== 'true' &&
            (typeof editor.value === 'string' || editor.isContentEditable ||
             editor.getAttribute('contenteditable') === 'true'));
        let staleReplyFlag = false;
        let staleSidebar = false;
        const now = Date.now();
        const fingerprint = getAssistantElements().length + ':' + (lastTurn?.textContent || '');
        if (assistantActivityFingerprint !== null && lastTurn && assistantActivityFingerprint !== fingerprint) {
            assistantActivityAt = now;
        }
        assistantActivityFingerprint = fingerprint;
        const recentActivity = assistantActivityAt !== null && now - assistantActivityAt < TAB_ACTIVITY_WINDOW_MS;
        if (sidebar === 'working' && !stopButton && !replyFlag && !unansweredUserTurn && composerEditable && lastTurn) {
            if (sidebarOnlySinceMs === null || sidebarOnlyFingerprint !== fingerprint) {
                sidebarOnlySinceMs = now;
                sidebarOnlyFingerprint = fingerprint;
            }
            staleSidebar = now - sidebarOnlySinceMs >= SIDEBAR_STALE_MS;
        } else {
            sidebarOnlySinceMs = null;
            sidebarOnlyFingerprint = null;
        }

        // ChatGPT sometimes leaves a response attribute "busy" after an
        // interrupted reply. Clear only this weak signal (never a real Stop
        // button or sidebar spinner) once we have 45s of corroborating idle
        // evidence and unchanged assistant content. Text updates reset the wait.
        if (replyFlag && !stopButton && sidebar !== 'working') {
            const text = lastTurn?.textContent || '';
            const fingerprint = text.length + ':' + text.slice(-160);
            if (weakBusyTextFingerprint !== fingerprint || !weakBusySinceMs) {
                weakBusyTextFingerprint = fingerprint;
                weakBusySinceMs = Date.now();
            } else {
                const timeout = sidebar === 'idle' && composerEditable
                    ? UNCORROBORATED_BUSY_STALE_MS : UNCERTAIN_BUSY_STALE_MS;
                staleReplyFlag = Date.now() - weakBusySinceMs >= timeout;
            }
        } else {
            weakBusySinceMs = 0;
                weakBusyTextFingerprint = null;
        }

        return {
            sidebar,
            staleSidebar,
            sidebarOnlyMs: sidebarOnlySinceMs === null ? 0 : now - sidebarOnlySinceMs,
            recentActivity,
            unansweredUserTurn,
            stopButton,
            replyFlag,
            staleReplyFlag,
            sendReady,
            composerEditable,
            // A stale sidebar is ambiguous, not proof of completion.
            active: (sidebar === 'working' && !staleSidebar) || stopButton || unansweredUserTurn || recentActivity || (replyFlag && !staleReplyFlag)
        };
    }

    function normalizeText(raw) {
        return (raw || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getLastAssistantText() {
        const turns = getAssistantElements();
        if (!turns.length) return '';
        const lastTurn = turns[turns.length - 1];
        return normalizeText(lastTurn.innerText || lastTurn.textContent || '');
    }

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function hasStopWordInLastReply(word) {
        const cleanWord = normalizeText(word);
        if (!cleanWord) return false;
        const replyText = getLastAssistantText();
        if (!replyText) return false;

        const escaped = escapeRegExp(cleanWord);
        // Match a complete marker (including underscores), not e.g. STOP_IT_OLD.
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu')
            .test(replyText);
    }

    function getSendButton() {
        const root = getComposerRoot();
        if (!root) return null;
        const selectors = [
            'button[data-testid="send-button"]',
            'button#composer-submit-button',
            'button[data-composer-submit="true"]',
            'button[aria-label="Отправить"], button[aria-label="Отправить сообщение"], button[aria-label="Send"], button[aria-label="Send message"]',
            '[data-composer-trailing-controls="true"] button.bg-composer-primary:not([data-composer-voice-start="true"])'
        ];
        let disabledCandidate = null;
        for (const selector of selectors) {
            const candidates = [...root.querySelectorAll(selector)].filter(btn =>
                isVisibleControl(btn) && !btn.matches('[data-composer-stop="true"], [data-composer-voice-start="true"], [data-testid="stop-button"]') &&
                !/stop|voice|останов|голос/iu.test(btn.getAttribute('aria-label') || ''));
            const ready = candidates.find(btn => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true');
            if (ready) return ready;
            if (!disabledCandidate && candidates.length) disabledCandidate = candidates[0];
        }
        return disabledCandidate;
    }

    function updateStatusTooltip(diagnostics) {
        if (!statusBadgeEl) return;
        if (diagnostics !== undefined) statusBadgeEl.dataset.diagnostics = diagnostics;
        statusBadgeEl.title = [statusBadgeEl.textContent, statusBadgeEl.dataset.diagnostics]
            .filter(Boolean).join('\n\n');
    }

    function setStatus(text, state = 'idle') {
        if (!statusBadgeEl) return;

        if (Date.now() < manualBlockUntil && state !== 'send') {
            text = manualBlockReason;
            state = 'stop';
        }
        statusBadgeEl.dataset.rawStatus = text;
        statusBadgeEl.textContent = tr(text);
        statusBadgeEl.dataset.state = state;
        updateStatusTooltip();

        const colors = {
            idle: { bg: 'rgba(59, 130, 246, 0.16)', fg: '#93c5fd' },
            gen: { bg: 'rgba(234, 179, 8, 0.16)', fg: '#fde047' },
            send: { bg: 'rgba(34, 197, 94, 0.18)', fg: '#86efac' },
            stop: { bg: 'rgba(244, 63, 94, 0.2)', fg: '#fda4af' },
            off: { bg: 'rgba(148, 163, 184, 0.16)', fg: '#cbd5e1' }
        };
        const c = colors[state] || colors.idle;
        statusBadgeEl.style.background = c.bg;
        statusBadgeEl.style.color = c.fg;
    }

    function updateScrollUI() {
        if (!scrollBtnEl) return;
        scrollBtnEl.textContent = autoScrollEnabled ? '⇩' : '↧';
        scrollBtnEl.title = tr(autoScrollEnabled
            ? 'Автоскролл включён (нажмите, чтобы выключить)'
            : 'Автоскролл выключен (нажмите, чтобы включить)');
        scrollBtnEl.style.opacity = autoScrollEnabled ? '1' : '0.55';
        scrollBtnEl.style.borderColor = autoScrollEnabled
            ? 'rgba(59, 130, 246, 0.5)'
            : 'rgba(148, 163, 184, 0.25)';
    }

    function updateSoundUI() {
        if (!soundBtnEl) return;
        soundBtnEl.textContent = soundEnabled ? '🔊' : '🔇';
        soundBtnEl.title = tr(soundEnabled
            ? 'Звук включён (нажмите, чтобы выключить)'
            : 'Звук выключен (нажмите, чтобы включить)');
        soundBtnEl.style.opacity = soundEnabled ? '1' : '0.6';
    }

    function updateStatsUI() {
        if (compactCountEl) {
            compactCountEl.textContent = `${sessionCount}x`;
        }
        if (!statsEl) return;

        const now = Date.now();
        const elapsedStr = enabled && enabledSinceMs ? formatDuration(now - enabledSinceMs) : formatDuration(0);
        const avgMs =
            cycleDurationsMs.length > 0
                ? cycleDurationsMs.reduce((acc, v) => acc + v, 0) / cycleDurationsMs.length
                : null;
        const avgStr = avgMs !== null ? formatDuration(avgMs) : '-';
        const stopWordDisplay = stopWord ? stopWord : tr('откл');

        // The marker is user-editable; inserting it into innerHTML is unsafe.
        const row1 = document.createElement('div');
        row1.textContent = `${tr('Продолжений')}: ${sessionCount} · ${tr('Стоп')}: ${stopWordDisplay}`;
        const row2 = document.createElement('div');
        row2.textContent = `${tr('Прошло')}: ${elapsedStr} · ${tr('Среднее')}: ${avgStr}`;
        statsEl.replaceChildren(row1, row2);
    }

    function updateToggleUI() {
        if (!toggleBtnEl) return;
        toggleBtnEl.textContent = tr(enabled ? 'Вкл' : 'Выкл');
        toggleBtnEl.style.background = enabled ? '#16a34a' : '#334155';
        toggleBtnEl.style.color = '#ffffff';
        toggleBtnEl.setAttribute('aria-pressed', String(enabled));

        if (!enabled) {
            if (statusBadgeEl?.dataset.state !== 'stop') {
                setStatus('Выключено', 'off');
            }
        } else if (!isSubmitting) {
            const streaming = getGenerationSignals().active;
            setStatus(streaming ? 'Генерация...' : 'Ожидание', streaming ? 'gen' : 'idle');
        }
        updateStatsUI();
    }

    function getComposerText(el) {
        if (!el) return '';
        return typeof el.value === 'string'
            ? el.value
            : (el.innerText || el.textContent || '');
    }

    function selectComposerContents(el) {
        const selection = window.getSelection();
        if (!selection) return false;
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    function composerContainsExpectedText(el, value) {
        return normalizeText(getComposerText(el)) === normalizeText(value);
    }

    function setComposerText(el, value) {
        if (!el || !el.isConnected || getComposerText(el).trim()) return false;

        if (typeof el.value === 'string') {
            el.focus();
            const prototype = el.tagName === 'TEXTAREA'
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return composerContainsExpectedText(el, value);
        }

        if (el.getAttribute('contenteditable') !== 'true') return false;

        // A number of ChatGPT editor variants use ProseMirror. Only supported
        // editing events should mutate its document; assigning innerHTML would
        // bypass the editor's state and might send an empty/stale message.
        const attempt = (operation) => {
            if (!el.isConnected || getComposerText(el).trim()) return false;
            try {
                el.focus();
                if (!selectComposerContents(el)) return false;
                operation();
            } catch (_) {}
            // execCommand may return false even when the DOM actually changed.
            // Verify the resulting content rather than the command's return value.
            return composerContainsExpectedText(el, value);
        };

        // Clipboard paste is handled by ProseMirror and preserves multiline text.
        if (attempt(() => {
            if (typeof DataTransfer === 'undefined' || typeof ClipboardEvent === 'undefined') return;
            const data = new DataTransfer();
            data.setData('text/plain', value);
            el.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: data
            }));
        })) return true;
        if (attempt(() => document.execCommand('insertText', false, value))) return true;

        // Some Chromium editor versions accept HTML insertion but not plain
        // insertText. Escape all user-supplied content before building markup.
        if (attempt(() => {
            const escaped = value.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            document.execCommand('insertHTML', false,
                escaped.split('\n').map(line => '<p>' + (line || '<br>') + '</p>').join(''));
        })) return true;

        return false;
    }

    function getUserMessageSnapshot() {
        const messages = [...document.querySelectorAll('[data-message-author-role="user"]')];
        const last = messages[messages.length - 1];
        return {
            count: messages.length,
            id: last?.getAttribute('data-message-id') || last?.getAttribute('data-dil-message-id') || '',
            text: normalizeText(last?.innerText || last?.textContent || '')
        };
    }

    function getAssistantSnapshot() {
        const turns = getAssistantElements();
        const last = turns[turns.length - 1];
        return {
            count: turns.length,
            id: last?.getAttribute?.('data-message-id') || last?.getAttribute?.('data-dil-message-id') || '',
            text: normalizeText(last?.textContent || '')
        };
    }

    function hasAssistantAdvanced(before, after) {
        return after.count > before.count ||
            Boolean(after.id && after.id !== before.id) ||
            Boolean(after.text && after.text !== before.text);
    }

    function isSubmissionConfirmed(before, after, expectedText, editorText, assistantAdvanced, stopAppeared = false) {
        // Stop was absent immediately before our click. Its appearance proves
        // that ChatGPT has begun processing, even if message nodes are reused.
        if (stopAppeared) return true;
        const newUserTurn = after.count > before.count ||
            Boolean(after.id && after.id !== before.id);
        const expected = normalizeText(expectedText);
        const actual = normalizeText(after.text);
        const draftCleared = !normalizeText(editorText);
        const matchingUserTurn = newUserTurn && Boolean(expected) &&
            (actual === expected || (draftCleared && actual.includes(expected)));
        return matchingUserTurn || (assistantAdvanced && draftCleared);
    }

    function triggerSend() {
        const sendBtn = getSendButton();
        if (!sendBtn || !sendBtn.isConnected || sendBtn.disabled ||
            sendBtn.getAttribute('aria-disabled') === 'true') return false;
        try {
            lastSendStage = 'Клик: ' + (sendBtn.getAttribute('data-testid') || sendBtn.id || sendBtn.getAttribute('aria-label') || 'composer');
            sendBtn.click();
            return true;
        } catch (_) {
            return false;
        }
    }

    function getActivePromptText() {
        const raw = promptInputEl ? promptInputEl.value : continueText;
        return typeof raw === 'string' && raw.trim().length > 0 ? raw : defaultContinueText();
    }

    function getActiveStopPromptText() {
        const raw = stopPromptInputEl ? stopPromptInputEl.value : stopPrompt;
        return typeof raw === 'string' ? raw.trim() : '';
    }

    function getActiveStopWord() {
        const raw = stopWordInputEl ? stopWordInputEl.value : stopWord;
        return typeof raw === 'string' ? raw.trim() : '';
    }

    function buildFullPrompt(basePrompt, stopRulePrompt, word) {
        const resolvedStopRule = word
            ? stopRulePrompt.replace(/\{STOP_WORD\}/g, word).trim()
            : stopRulePrompt.trim();

        if (!resolvedStopRule) {
            return basePrompt;
        }

        const cleanBase = basePrompt.replace(/[.!?]+$/g, '').trim();
        const hasFullRule = cleanBase.toLowerCase().includes(resolvedStopRule.toLowerCase());
        if (hasFullRule) {
            return basePrompt;
        }

        const formattedRule = /[.!?]$/.test(resolvedStopRule) ? resolvedStopRule : `${resolvedStopRule}.`;
        return `${cleanBase}. ${formattedRule}`;
    }

    function persistCurrentSettings(includeStats = true) {
        // Global: prompt settings only. Per-tab: armed state and statistics.
        saveChatConfig(
            currentChatKey,
            getActivePromptText(),
            getActiveStopPromptText(),
            getActiveStopWord()
        );
        saveTabChatState(currentChatKey, includeStats);
    }

    function recordContinuationSent() {
        const now = Date.now();
        if (cycleStartMs && now > cycleStartMs) {
            cycleDurationsMs.push(now - cycleStartMs);
            if (cycleDurationsMs.length > 200) {
                cycleDurationsMs.shift();
            }
        }
        cycleStartMs = now;
        sessionCount += 1;
        persistCurrentSettings(true);
        updateStatsUI();
    }

    function triggerStopWordDetected(disableAutoContinue = true) {
        completionCandidateSinceMs = 0;
        wasGenerating = false;
        if (disableAutoContinue) {
            enabled = false;
            enabledSinceMs = null;
            persistCurrentSettings(true);
        }
        updateToggleUI();
        showTabNotice('stopped', 'Стоп-слово');
        if (!stopNotifiedForCurrentReply) {
            stopNotifiedForCurrentReply = true;
            playStopBeepSound();
        }
    }

    function clearPendingOwnedDraft() {
        const owned = pendingOwnedDraft;
        pendingOwnedDraft = null;
        if (!owned || !owned.input.isConnected || getConversationKey() !== owned.chatKey ||
            normalizeText(getComposerText(owned.input)) !== normalizeText(owned.text)) return;

        // Only remove text inserted by this script and left unchanged by the user.
        const input = owned.input;
        if (typeof input.value === 'string') {
            const prototype = input.tagName === 'TEXTAREA'
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(input, '');
            else input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            try {
                input.focus();
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(input);
                selection.removeAllRanges();
                selection.addRange(range);
                document.execCommand('delete', false);
            } catch (_) {}
        }
    }

    function cancelPendingSend() {
        ++pendingSubmitToken;
        clearTimeout(pendingSubmitTimerId);
        pendingSubmitTimerId = null;
        isSubmitting = false;
        clearPendingOwnedDraft();
    }

    function showManualBlock(reason) {
        manualBlockReason = reason;
        manualBlockUntil = Date.now() + 5000;
        setStatus(reason, 'stop');
    }

    function generationBlocksSend(signals, forceSend) {
        if (signals.stopButton || signals.replyFlag || signals.recentActivity || signals.unansweredUserTurn) return true;
        if (forceSend && signals.composerEditable) return false;
        return signals.active || signals.staleSidebar;
    }

    function handleSubmissionException(error) {
        // Keep any unsent text and expose the actual failure instead of hanging.
        lastSendStage = 'Ошибка отправки: ' + (error?.name || 'Error');
        pendingOwnedDraft = null;
        console.error('[ChatGPT Auto Continue] Submission failed', error);
        pauseForUiFailure('error', lastSendStage);
    }

    function scheduleSendStep(step, delay) {
        pendingSubmitTimerId = setTimeout(() => {
            try { step(); } catch (error) { handleSubmissionException(error); }
        }, delay);
    }

    function runContinueNow(forceSend = false) {
        try { performContinuation(forceSend); }
        catch (error) { handleSubmissionException(error); }
    }

    function performContinuation(forceSend = false) {
        if (disposed || (!forceSend && !enabled)) return;
        if (forceSend) manualBlockUntil = 0;
        const signals = getGenerationSignals();
        const blockReason = isSubmitting ? 'Отправка уже выполняется'
            : awaitingReply ? 'Ожидание предыдущего ответа'
            : generationBlocksSend(signals, forceSend) ? 'Генерация ещё активна' : '';
        if (blockReason) {
            if (forceSend) showManualBlock(blockReason);
            return;
        }
        const failure = getExplicitUiFailure();
        if (failure) {
            pauseForUiFailure(failure.mode, failure.reason);
            return;
        }
        // An explicit retry may raise the same notice again if it fails.
        clearTabNotice();
        const word = getActiveStopWord();
        if (!forceSend && hasStopWordInLastReply(word)) {
            triggerStopWordDetected(true);
            return;
        }

        const input = getComposerInput();
        if (!input) {
            showTabNotice('error', 'Поле ввода не найдено');
            return;
        }
        const textToSend = buildFullPrompt(
            getActivePromptText(), getActiveStopPromptText(), word
        );
        const existingDraft = getComposerText(input).trim();
        if (existingDraft && (!forceSend || !composerContainsExpectedText(input, textToSend))) {
            showTabNotice('warning', 'Черновик не пуст — отправка отменена');
            return;
        }
        lastSendStage = existingDraft ? 'Повтор: готовый черновик' : 'Заполнение редактора';
        if (!textToSend.trim() || (!existingDraft && !setComposerText(input, textToSend))) {
            showTabNotice('error', 'Не удалось заполнить поле ввода');
            return;
        }

        const chatKeyAtStart = getConversationKey();
        pendingOwnedDraft = existingDraft ? null : { input, text: textToSend, chatKey: chatKeyAtStart };
        lastSendStage = 'Черновик готов';
        const submissionId = ++pendingSubmitToken;
        isSubmitting = true;
        setStatus('Отправка...', 'send');
        setTabIndicator('working');
        const startedAt = Date.now();

        const attemptSend = () => {
            if (disposed || submissionId !== pendingSubmitToken ||
                getConversationKey() !== chatKeyAtStart ||
                (!forceSend && !enabled)) {
                cancelPendingSend();
                return;
            }
            if (generationBlocksSend(getGenerationSignals(), forceSend)) {
                cancelPendingSend();
                if (forceSend) showManualBlock('Генерация возобновилась');
                return;
            }
            const failure = getExplicitUiFailure();
            if (failure) {
                pauseForUiFailure(failure.mode, failure.reason);
                return;
            }
            // The user may have modified the draft while waiting.
            if (!composerContainsExpectedText(getComposerInput(), textToSend)) {
                cancelPendingSend();
                showTabNotice('warning', 'Черновик изменён — отправка отменена');
                return;
            }

            const assistantBefore = getAssistantSnapshot();
            const assistantCount = assistantBefore.count;
            const userBefore = getUserMessageSnapshot();
            const stopBefore = Boolean(getStopButton());
            if (stopBefore) {
                cancelPendingSend();
                if (forceSend) showManualBlock('Генерация возобновилась');
                return;
            }
            if (triggerSend()) {
                // Clicking is not confirmation. Do not clear the draft or click twice.
                pendingOwnedDraft = null;
                const clickedAt = Date.now();
                const confirmSend = () => {
                    if (disposed || submissionId !== pendingSubmitToken ||
                        getConversationKey() !== chatKeyAtStart) {
                        cancelPendingSend();
                        return;
                    }
                    const editorText = getComposerText(getComposerInput());
                    const assistantAdvanced = hasAssistantAdvanced(assistantBefore, getAssistantSnapshot());
                    const signals = getGenerationSignals();
                    const stopAppeared = !stopBefore && signals.stopButton;
                    const generationStarted = stopAppeared || assistantAdvanced ||
                        (signals.replyFlag && !signals.staleReplyFlag && !normalizeText(editorText));
                    if (isSubmissionConfirmed(userBefore, getUserMessageSnapshot(), textToSend, editorText, assistantAdvanced, stopAppeared)) {
                        lastSendStage = 'Отправка подтверждена';
                        completionCandidateSinceMs = 0;
                        hasCompletedOnce = false;
                        submittedAssistantCount = assistantCount;
                        submittedAtMs = clickedAt;
                        tabRequestStartedAtMs = clickedAt;
                        awaitingReply = !generationStarted;
                        wasGenerating = generationStarted;
                        stopNotifiedForCurrentReply = false;
                        isSubmitting = false;
                        pendingSubmitTimerId = null;
                        recordContinuationSent();
                        try { playTickSound(); } catch (_) {}
                        setStatus(generationStarted ? 'Генерация...' : 'Ожидание ответа...', generationStarted ? 'gen' : 'idle');
                        return;
                    }
                    if (Date.now() - clickedAt >= SEND_CONFIRM_TIMEOUT_MS) {
                        lastSendStage = 'Клик без подтверждения';
                        pauseForUiFailure('warning', 'Отправка не подтверждена — проверьте черновик');
                        return;
                    }
                    scheduleSendStep(confirmSend, 200);
                };
                confirmSend();
                return;
            }
            if (Date.now() - startedAt >= SEND_READY_TIMEOUT_MS) {
                lastSendStage = 'Кнопка отправки недоступна';
                pendingOwnedDraft = null; // Preserve the draft for manual recovery.
                pauseForUiFailure('error', 'Кнопка отправки недоступна');
                return;
            }
            scheduleSendStep(attemptSend, 200);
        };
        scheduleSendStep(attemptSend, SUBMIT_DELAY_MS);
    }

    function createFloatingPanel() {
        if (disposed) return;
        document.getElementById(PANEL_ID)?.remove();

        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        panelEl.style.cssText = [
            'position: fixed',
            'right: 20px',
            'bottom: 96px',
            'z-index: 99999',
            'display: flex',
            'flex-direction: column',
            'gap: 8px',
            'width: 312px',
            'max-width: calc(100vw - 24px)',
            'box-sizing: border-box',
            'max-height: calc(100vh - 24px)',
            'overflow: auto',
            'padding: 9px 11px',
            'border-radius: 12px',
            'background: rgba(15, 23, 42, 0.94)',
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35)',
            'backdrop-filter: blur(8px)',
            'color: #f8fafc',
            'font-family: system-ui, -apple-system, sans-serif',
            'font-size: 12px',
            'line-height: 1.25',
            'user-select: none'
        ].join(';');

        const staticLabels = [];
        const label = (element, property, text) => {
            staticLabels.push({element, property, text});
            element[property] = tr(text);
        };
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; flex-shrink: 0;';

        const dragHandle = document.createElement('span');
        label(dragHandle, 'title', 'Перетащить панель');
        dragHandle.textContent = '⠿';
        dragHandle.style.cssText = 'cursor: grab; color: #94a3b8; font-size: 13px; padding: 0 2px;';

        statusBadgeEl = document.createElement('span');
        statusBadgeEl.style.cssText = [
            'padding: 4px 7px',
            'border-radius: 999px',
            'font-size: 11px',
            'font-weight: 500',
            'white-space: nowrap',
            'flex: 1 1 auto',
            'min-width: 0',
            'overflow: hidden',
            'text-overflow: ellipsis'
        ].join(';');

        compactCountEl = document.createElement('span');
        label(compactCountEl, 'title', 'Число продолжений в текущем чате');
        compactCountEl.style.cssText = [
            'font-size: 11px',
            'font-weight: 600',
            'color: #cbd5e1',
            'padding: 0 2px',
            'white-space: nowrap'
        ].join(';');

        collapseBtnEl = document.createElement('button');
        collapseBtnEl.type = 'button';
        collapseBtnEl.style.cssText = [
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'border-radius: 8px',
            'padding: 3px 7px',
            'font-size: 12px',
            'font-weight: 700',
            'cursor: pointer',
            'background: rgba(30, 41, 59, 0.85)',
            'color: #f8fafc'
        ].join(';');
        collapseBtnEl.addEventListener('click', () => {
            collapsed = !collapsed;
            saveBoolPref(STORAGE_COLLAPSED_KEY, collapsed);
            updateCollapsedUI();
        });

        scrollBtnEl = document.createElement('button');
        scrollBtnEl.type = 'button';
        scrollBtnEl.style.cssText = [
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'border-radius: 8px',
            'padding: 4px 6px',
            'font-size: 12px',
            'cursor: pointer',
            'background: rgba(30, 41, 59, 0.85)',
            'color: #f8fafc'
        ].join(';');
        scrollBtnEl.addEventListener('click', () => {
            autoScrollEnabled = !autoScrollEnabled;
            saveBoolPref(STORAGE_AUTOSCROLL_KEY, autoScrollEnabled);
            if (autoScrollEnabled) {
                userScrolledAway = false;
                performAutoScroll();
            }
            updateScrollUI();
        });

        soundBtnEl = document.createElement('button');
        soundBtnEl.type = 'button';
        soundBtnEl.style.cssText = [
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'border-radius: 8px',
            'padding: 4px 6px',
            'font-size: 12px',
            'cursor: pointer',
            'background: rgba(30, 41, 59, 0.85)',
            'color: #f8fafc'
        ].join(';');
        soundBtnEl.addEventListener('click', () => {
            soundEnabled = !soundEnabled;
            saveBoolPref(STORAGE_SOUND_KEY, soundEnabled);
            updateSoundUI();
            if (soundEnabled) {
                ensureAudioContext();
                playTickSound();
            }
        });

        sendNowBtnEl = document.createElement('button');
        sendNowBtnEl.type = 'button';
        label(sendNowBtnEl, 'title', 'Отправить промпт сейчас');
        sendNowBtnEl.textContent = '▶';
        sendNowBtnEl.style.cssText = [
            'border: none',
            'border-radius: 8px',
            'padding: 5px 8px',
            'font-size: 11px',
            'font-weight: 600',
            'cursor: pointer',
            'background: #2563eb',
            'color: #ffffff'
        ].join(';');
        sendNowBtnEl.addEventListener('click', () => {
            try { ensureAudioContext(); } catch (_) {}
            runContinueNow(true);
        });

        toggleBtnEl = document.createElement('button');
        toggleBtnEl.type = 'button';
        toggleBtnEl.style.cssText = [
            'border: none',
            'border-radius: 8px',
            'padding: 5px 9px',
            'font-size: 12px',
            'font-weight: 600',
            'cursor: pointer',
            'transition: background-color 0.15s ease'
        ].join(';');

        toggleBtnEl.addEventListener('click', () => {
            ensureAudioContext();
            enabled = !enabled;
            if (enabled) {
                stopNotifiedForCurrentReply = false;
                resetSessionStats(true);
            } else {
                cancelPendingSend();
                awaitingReply = false;
                completionCandidateSinceMs = 0;
                enabledSinceMs = null;
            }
            persistCurrentSettings(true);
            updateToggleUI();
        });

        bodyContainerEl = document.createElement('div');
        bodyContainerEl.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

        const promptRow = document.createElement('div');
        promptRow.style.cssText = 'display: flex; align-items: flex-start; gap: 6px;';

        promptInputEl = document.createElement('textarea');
        promptInputEl.rows = 3;
        label(promptInputEl, 'placeholder', 'Промпт для продолжения...');

        label(promptInputEl, 'title', 'Базовый промпт (поддерживает несколько строк; к нему добавится стоп-промпт)');
        promptInputEl.value = continueText;
        promptInputEl.style.cssText = [
            'flex: 1',
            'min-width: 0',
            'box-sizing: border-box',
            'resize: vertical',
            'min-height: 54px',
            'max-height: 180px',
             'padding: 5px 8px',
             'border-radius: 8px',
             'border: 1px solid rgba(148, 163, 184, 0.3)',
             'background: rgba(30, 41, 59, 0.9)',
             'color: #f8fafc',
            'font-family: inherit',
            'font-size: 12px',
            'line-height: 1.35',
             'outline: none',
             'user-select: text'
         ].join(';');
		

        promptInputEl.addEventListener('input', () => {
            continueText = promptInputEl.value;
            persistCurrentSettings(true);
        });

        promptInputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
        });

        const resetPromptBtn = document.createElement('button');
        resetPromptBtn.type = 'button';
        label(resetPromptBtn, 'title', 'Сбросить промпт, стоп-промпт и стоп-слово');
        resetPromptBtn.textContent = '↺';
        resetPromptBtn.style.cssText = [
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'border-radius: 8px',
            'padding: 4px 7px',
            'font-size: 12px',
            'cursor: pointer',
            'background: rgba(30, 41, 59, 0.8)',
            'color: #cbd5e1'
        ].join(';');
        resetPromptBtn.addEventListener('click', () => {
            continueText = defaultContinueText();
            stopPrompt = defaultStopPrompt();
            stopWord = DEFAULT_STOP_WORD;
            promptInputEl.value = continueText;
            if (stopPromptInputEl) stopPromptInputEl.value = stopPrompt;
            if (stopWordInputEl) stopWordInputEl.value = stopWord;
            persistCurrentSettings(true);
            updateStatsUI();
        });

        const stopPromptBox = document.createElement('div');
        stopPromptBox.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

        const stopPromptLabel = document.createElement('span');
        label(stopPromptLabel, 'textContent', 'Стоп-промпт (поддерживает {STOP_WORD}):');
        stopPromptLabel.style.cssText = 'font-size: 10px; color: #94a3b8;';

        stopPromptInputEl = document.createElement('textarea');
        stopPromptInputEl.rows = 2;
        label(stopPromptInputEl, 'placeholder', 'Правило остановки...');
        label(stopPromptInputEl, 'title', 'Инструкция об условиях вывода стоп-слова (сохраняется для каждого чата)');
        stopPromptInputEl.value = stopPrompt;
        stopPromptInputEl.style.cssText = [
            'width: 100%',
            'box-sizing: border-box',
            'resize: vertical',
            'min-height: 40px',
            'max-height: 110px',
            'padding: 5px 7px',
            'border-radius: 8px',
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'background: rgba(30, 41, 59, 0.8)',
            'color: #e2e8f0',
            'font-family: inherit',
            'font-size: 11px',
            'line-height: 1.3',
            'outline: none',
            'user-select: text'
        ].join(';');

        stopPromptInputEl.addEventListener('input', () => {
            stopPrompt = stopPromptInputEl.value;
            persistCurrentSettings(true);
        });

        stopPromptInputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
        });

        const stopRow = document.createElement('div');
        stopRow.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; color: #94a3b8;';

        const stopLabel = document.createElement('span');
        label(stopLabel, 'textContent', 'Стоп-слово:');
        stopLabel.style.cssText = 'white-space: nowrap;';

        stopWordInputEl = document.createElement('input');
        stopWordInputEl.type = 'text';
        stopWordInputEl.placeholder = 'STOP_IT';
        label(stopWordInputEl, 'title', 'Если агент выведет это слово, сработает звуковой сигнал и автопродолжение выключится');
        stopWordInputEl.value = stopWord;
        stopWordInputEl.style.cssText = [
            'flex: 1',
            'min-width: 0',
            'padding: 4px 7px',
            'border-radius: 7px',
            'border: 1px solid rgba(148, 163, 184, 0.25)',
            'background: rgba(30, 41, 59, 0.75)',
            'color: #fda4af',
            'font-size: 11px',
            'font-weight: 600',
            'outline: none',
            'user-select: text'
        ].join(';');

        stopWordInputEl.addEventListener('input', () => {
            stopWord = stopWordInputEl.value;
            persistCurrentSettings(true);
            updateStatsUI();
        });

        stopWordInputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                stopWord = getActiveStopWord();
                stopWordInputEl.value = stopWord;
                persistCurrentSettings(true);
                stopWordInputEl.blur();
                updateStatsUI();
            }
        });

        statsEl = document.createElement('div');
        statsEl.style.cssText = [
            'padding-top: 6px',
            'border-top: 1px solid rgba(148, 163, 184, 0.16)',
            'display: flex',
            'flex-direction: column',
            'gap: 3px',
            'font-size: 11px',
            'color: #cbd5e1'
        ].join(';');

        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragHandle.style.cursor = 'grabbing';
            const rect = panelEl.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            panelEl.style.right = 'auto';
            panelEl.style.bottom = 'auto';
            e.preventDefault();
        });

        const onMouseMove = (e) => {
            if (!isDragging || !panelEl) return;
            applyPanelPosition(e.clientX - offsetX, e.clientY - offsetY, false);
        };

        const onMouseUp = () => {
            if (!isDragging || !panelEl) return;
            isDragging = false;
            dragHandle.style.cursor = 'grab';
            clampPanelToViewport(true);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Reserve the width of every control; only the status may shrink.
        for (const control of [dragHandle, compactCountEl, scrollBtnEl, soundBtnEl, sendNowBtnEl, toggleBtnEl, collapseBtnEl]) {
            control.style.flex = '0 0 auto';
        }
        topRow.appendChild(dragHandle);
        topRow.appendChild(statusBadgeEl);
        topRow.appendChild(compactCountEl);
        topRow.appendChild(scrollBtnEl);
        topRow.appendChild(soundBtnEl);
        topRow.appendChild(sendNowBtnEl);
        topRow.appendChild(toggleBtnEl);
        topRow.appendChild(collapseBtnEl);

        promptRow.appendChild(promptInputEl);
        promptRow.appendChild(resetPromptBtn);

        stopPromptBox.appendChild(stopPromptLabel);
        stopPromptBox.appendChild(stopPromptInputEl);

        stopRow.appendChild(stopLabel);
        stopRow.appendChild(stopWordInputEl);

        bodyContainerEl.appendChild(promptRow);
        bodyContainerEl.appendChild(stopPromptBox);
        bodyContainerEl.appendChild(stopRow);
        const languageRow = document.createElement('div');
        languageRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:#94a3b8;';
        const languageLabel = document.createElement('span');
        label(languageLabel, 'textContent', 'Язык интерфейса');
        const languageSelect = document.createElement('select');
        languageSelect.style.cssText = 'max-width:110px;color:#e2e8f0;background:#1e293b;border:1px solid #475569;border-radius:6px;padding:3px 5px;font:inherit;cursor:pointer;';
        label(languageSelect, 'title', 'Язык интерфейса');
        for (const [value, name] of [['en', 'English'], ['ru', 'Русский']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = name;
            languageSelect.appendChild(option);
        }
        languageSelect.value = language;
        languageSelect.addEventListener('change', () => setLanguage(languageSelect.value));
        languageSelect.addEventListener('keydown', e => e.stopPropagation());
        languageRow.append(languageLabel, languageSelect);
        bodyContainerEl.appendChild(languageRow);
        bodyContainerEl.appendChild(statsEl);

        refreshLanguageUI = () => {
            for (const entry of staticLabels) entry.element[entry.property] = tr(entry.text);
            languageSelect.value = language;
            updateScrollUI();
            updateSoundUI();
            updateCollapsedUI();
            toggleBtnEl.textContent = tr(enabled ? 'Вкл' : 'Выкл');
            if (statusBadgeEl.dataset.rawStatus) {
                setStatus(statusBadgeEl.dataset.rawStatus, statusBadgeEl.dataset.state);
            }
            updateStatusTooltip();
            updateStatsUI();
            applyTitleMode(tabIndicatorMode);
        };

        panelEl.appendChild(topRow);
        panelEl.appendChild(bodyContainerEl);

        document.body.appendChild(panelEl);

        updateCollapsedUI();

        const savedPos = loadJSON(STORAGE_POS_KEY, null);
        if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
            applyPanelPosition(savedPos.left, savedPos.top, false);
        } else {
            const vp = getViewportBounds();
            applyPanelPosition(
                vp.width - panelEl.offsetWidth - 20,
                vp.height - panelEl.offsetHeight - 96,
                false
            );
        }

        updateScrollUI();
        updateSoundUI();
        updateToggleUI();
        updateStatsUI();

        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
    }

    function onWheelOrTouch() {
        if (!autoScrollEnabled) return;
        const container = getScrollContainer();
        if (!container) return;
        const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
        if (distanceFromBottom > 120) {
            userScrolledAway = true;
        }
    }

    function onScrollEvent() {
        const container = getScrollContainer();
        if (!container) return;
        const currentTop = container.scrollTop;
        const distanceFromBottom = container.scrollHeight - container.clientHeight - currentTop;

        if (currentTop < lastScrollTop - 12 && distanceFromBottom > 120) {
            userScrolledAway = true;
        } else if (distanceFromBottom <= 48) {
            userScrolledAway = false;
        }
        lastScrollTop = currentTop;
    }

    function onViewportResize() {
        clampPanelToViewport(false);
    }

    function tick() {
        if (disposed) return;

        try {
            const activeInst = sessionStorage.getItem(INSTANCE_KEY);
            if (activeInst && activeInst !== INSTANCE_ID) {
                cleanupInstance();
                return;
            }
        } catch (_) {}

        syncStateWithCurrentChat(false);
        startTitleGuard();

        if (!document.getElementById(PANEL_ID) && document.body) {
            if (typeof cleanupDrag === 'function') cleanupDrag();
            cleanupDrag = createFloatingPanel();
        } else {
            clampPanelToViewport(false);
        }

        if (isSubmitting) {
            setStatus('Отправка...', 'send');
            updateStatusTooltip(tr('Отправка: ') + tr(lastSendStage));
            setTabIndicator('working');
            updateStatsUI();
            return;
        }

        const signals = getGenerationSignals();
        const now = Date.now();
        if (statusBadgeEl) {
            updateStatusTooltip([
                tr('Генерация — диагностика'),
                tr('Отправка: ') + tr(lastSendStage),
                'Sidebar: ' + signals.sidebar,
                tr('Sidebar устарел: ') + (signals.staleSidebar ? tr('да') : tr('нет')),
                tr('Sidebar без подтверждения: ') + formatDuration(signals.sidebarOnlyMs),
                tr('Недавнее изменение ответа: ') + (signals.recentActivity ? tr('да') : tr('нет')),
                tr('Запрос без ответа: ') + (signals.unansweredUserTurn ? tr('да') : tr('нет')),
                tr('Кнопка Stop: ') + (signals.stopButton ? tr('да') : tr('нет')),
                tr('Атрибут busy: ') + (signals.replyFlag ? tr('да') : tr('нет')),
                tr('Busy устарел: ') + (signals.staleReplyFlag ? tr('да') : tr('нет')),
                tr('Отправка доступна: ') + (signals.sendReady ? tr('да') : tr('нет')),
                tr('Редактор доступен: ') + (signals.composerEditable ? tr('да') : tr('нет'))
            ].join('\n'));
        }

        // A stale reply flag is ambiguous: the user might have pressed Stop,
        // or ChatGPT might have failed to clear aria-busy after finishing.
        // Never convert this state directly into an automatic continuation.
        // Pause automation and tell the user to verify the conversation.
        if (signals.staleSidebar && !awaitingReply) {
            pauseForUiFailure('warning', 'Зависший Sidebar · проверка');
            updateStatsUI();
            return;
        }
        if (signals.staleReplyFlag) {
            pauseForUiFailure('warning', 'Зависший busy · проверка');
            updateStatsUI();
            return;
        }

        // A new assistant message confirms a successfully submitted continuation.
        // Sidebar activity alone is not proof that the new message was accepted.
        if (awaitingReply && (signals.stopButton || signals.recentActivity ||
            (signals.replyFlag && !signals.staleReplyFlag) ||
            getAssistantElements().length > submittedAssistantCount)) {
            awaitingReply = false;
            wasGenerating = true;
        }

        if (signals.unansweredUserTurn && !signals.stopButton && !signals.replyFlag && !signals.recentActivity) {
            const failure = getExplicitUiFailure();
            if (failure) {
                pauseForUiFailure(failure.mode, failure.reason);
                updateStatsUI();
                return;
            }
        }

        if (signals.active) {
            completionCandidateSinceMs = 0;
            if (!wasGenerating) {
                stopNotifiedForCurrentReply = false;
            }
            wasGenerating = true;
            setTabIndicator('working');
            sampleTabAssistantActivity(true, now);
            applyFaviconMode('working');
            setStatus(signals.sidebar === 'working' ? 'Генерация · чат'
                : signals.stopButton ? 'Генерация · Stop'
                    : signals.recentActivity ? 'Генерация · текст'
                        : signals.unansweredUserTurn ? 'Генерация · запрос'
                            : 'Генерация · busy', 'gen');
            performAutoScroll();
            updateStatsUI();
            return;
        }

        sampleTabAssistantActivity(false, now);

        // Do not treat a real generation as a failure just because an alert is
        // temporarily mounted. Evaluate explicit UI failures only while idle,
        // and only for a request or armed automation, or an already seen alert.
        if (wasGenerating || awaitingReply || enabled ||
            (tabNotice && /^(limit|error):.*ChatGPT/u.test(tabNotice.key))) {
            const failure = getExplicitUiFailure();
            if (failure) {
                pauseForUiFailure(failure.mode, failure.reason);
                updateStatsUI();
                return;
            }
        }

        if (awaitingReply) {
            // Do NOT send another prompt after an unconfirmed submission.
            if (now - submittedAtMs > RESPONSE_WAIT_TIMEOUT_MS) {
                awaitingReply = false;
                wasGenerating = false;
                completionCandidateSinceMs = 0;
                enabled = false;
                enabledSinceMs = null;
                persistCurrentSettings(true);
                updateToggleUI();
                showTabNotice('error', 'Нет ответа — выкл');
            } else {
                setTabIndicator('working');
                setStatus('Ожидание ответа...', 'idle');
            }
            updateStatsUI();
            return;
        }

        if (wasGenerating) {
             // Send can appear for a moment in the middle of a tool/reasoning
            // cycle. Require a stable quiet period before considering completion.
            if (!completionCandidateSinceMs) completionCandidateSinceMs = now;
            const delay = signals.sidebar === 'unknown'
                ? COMPLETION_STABLE_NO_SIDEBAR_MS : COMPLETION_STABLE_MS;
            const remaining = delay - (now - completionCandidateSinceMs);
            if (remaining > 0) {
                setTabIndicator('working');
                setStatus(`Проверка завершения: ${Math.ceil(remaining / 1000)}с`, 'gen');
                updateStatsUI();
                return;
            }
            completionCandidateSinceMs = 0;
            const stopFound = hasStopWordInLastReply(getActiveStopWord());
            wasGenerating = false;
            hasCompletedOnce = true;
            setTabIndicator('done');

            if (stopFound) {
                triggerStopWordDetected(true);
                return;
            }
            playTickSound();
            if (enabled) {
                runContinueNow(false);
                return;
            }
        } else if (hasCompletedOnce) {
            setTabIndicator('done');
        } else if (tabIndicatorMode === 'working') {
            setTabIndicator(null); // Canceled or failed submission.
        }

        acknowledgeTabCompletion(now);

        if (tabNotice) {
            // Keep the detailed reason in the panel even after its tab badge
            // has been acknowledged. A new request clears it.
            setStatus(tabNotice.reason, 'stop');
            updateStatsUI();
            return;
        }

        if (!enabled) {
            if (statusBadgeEl?.dataset.state !== 'stop') {
                setStatus('Выключено', 'off');
            }
            updateStatsUI();
            return;
        }

        setStatus('Ожидание', 'idle');
        updateStatsUI();
    }

    const onStorage = (e) => {
        if (disposed) return;
        if (e.key === STORAGE_LANGUAGE_KEY) {
            setLanguage(loadJSON(STORAGE_LANGUAGE_KEY, 'en'), false);
            return;
        }
        if (e.key !== STORAGE_CHATS_KEY && e.key !== STORAGE_DEFAULTS_KEY) return;
        // A second tab editing a prompt may refresh the text preferences, but
        // MUST NOT reset this tab's enabled flag, pending send or cycle state.
        if (getConversationKey() !== currentChatKey) return;
        const cfg = getChatConfig(currentChatKey);
        continueText = cfg.prompt;
        stopPrompt = cfg.stopPrompt;
        stopWord = cfg.stopWord;
        if (promptInputEl && document.activeElement !== promptInputEl) {
            promptInputEl.value = continueText;
        }
        if (stopPromptInputEl && document.activeElement !== stopPromptInputEl) {
            stopPromptInputEl.value = stopPrompt;
        }
        if (stopWordInputEl && document.activeElement !== stopWordInputEl) {
            stopWordInputEl.value = stopWord;
        }
        updateStatsUI();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('blur', resetTabReadFocus);
    window.addEventListener('focus', resetTabReadFocus);
    document.addEventListener('visibilitychange', resetTabReadFocus);
    window.addEventListener('wheel', onWheelOrTouch, { passive: true });
    window.addEventListener('touchstart', onWheelOrTouch, { passive: true });
    window.addEventListener('scroll', onScrollEvent, { passive: true, capture: true });
    window.addEventListener('resize', onViewportResize, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportResize, { passive: true });
    }

    captureOriginalFavicons();
    startTitleGuard();
    let cleanupDrag = createFloatingPanel();
    const intervalId = setInterval(tick, CHECK_INTERVAL_MS);

    function cleanupInstance() {
        if (disposed) return;
        disposed = true;
        clearInterval(intervalId);
        cancelPendingSend();
        awaitingReply = false;
        try {
            if (sessionStorage.getItem(INSTANCE_KEY) === INSTANCE_ID) {
                sessionStorage.removeItem(INSTANCE_KEY);
            }
        } catch (_) {}
        if (audioCtx && audioCtx.state !== 'closed') {
            audioCtx.close().catch(() => {});
        }
        if (titleObserver) {
            titleObserver.disconnect();
            titleObserver = null;
        }
        window.removeEventListener('storage', onStorage);
        window.removeEventListener('blur', resetTabReadFocus);
        window.removeEventListener('focus', resetTabReadFocus);
        document.removeEventListener('visibilitychange', resetTabReadFocus);
        window.removeEventListener('wheel', onWheelOrTouch);
        window.removeEventListener('touchstart', onWheelOrTouch);
        window.removeEventListener('scroll', onScrollEvent, { capture: true });
        window.removeEventListener('resize', onViewportResize);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', onViewportResize);
        }
        if (typeof cleanupDrag === 'function') cleanupDrag();
        restoreOriginalFavicons();
        if (basePageTitle) {
            document.title = basePageTitle;
        }
        document.getElementById(PANEL_ID)?.remove();
    }

    window.__cgptAutoContCleanup = cleanupInstance;
    syncStateWithCurrentChat(true);
})();
