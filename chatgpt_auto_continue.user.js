// ==UserScript==
// @name         ChatGPT Auto Continue + Floating Panel
// @namespace    http://tampermonkey.net/
// @version      1.19
// @updateURL    https://raw.githubusercontent.com/xandrx/chatgpt-auto-continue/main/chatgpt_auto_continue.user.js
// @downloadURL  https://raw.githubusercontent.com/xandrx/chatgpt-auto-continue/main/chatgpt_auto_continue.user.js
// @description  Автопродолжение с проверкой активности текущего чата в боковой панели, защитой от ложного завершения, звуками и статистикой
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

    const DEFAULT_CONTINUE_TEXT = 'Продолжай';
    const DEFAULT_STOP_WORD = 'STOP_IT';
    const DEFAULT_STOP_PROMPT =
        'Если дальнейших улучшений нет, напиши {STOP_WORD}. Если не рекомендовано для торговли, также напиши {STOP_WORD}';
    const CHECK_INTERVAL_MS = 800;
    const SUBMIT_DELAY_MS = 450;
    // Do not treat a quiet response as finished: thinking/tool calls can take minutes.
    const SEND_READY_TIMEOUT_MS = 3000;
    const RESPONSE_WAIT_TIMEOUT_MS = 90000;
    // The sidebar is a stronger positive indicator than the temporary Send button.
    // A response is complete only after ALL known activity signals stay quiet.
    const COMPLETION_STABLE_MS = 5000;
    const COMPLETION_STABLE_NO_SIDEBAR_MS = 10000;

    const STORAGE_DEFAULTS_KEY = 'cgpt_autocont_defaults_v4';
    const STORAGE_CHATS_KEY = 'cgpt_autocont_chats_v4';
    const STORAGE_POS_KEY = 'cgpt_autocont_pos_v1';
    const STORAGE_SOUND_KEY = 'cgpt_autocont_sound_v1';
    const STORAGE_AUTOSCROLL_KEY = 'cgpt_autocont_autoscroll_v1';
    const STORAGE_COLLAPSED_KEY = 'cgpt_autocont_collapsed_v1';

    let disposed = false;
    let currentChatKey = null;
    let enabled = true;
    let soundEnabled = loadBoolPref(STORAGE_SOUND_KEY, true);
    let autoScrollEnabled = loadBoolPref(STORAGE_AUTOSCROLL_KEY, true);
    let collapsed = loadBoolPref(STORAGE_COLLAPSED_KEY, false);
    let continueText = DEFAULT_CONTINUE_TEXT;
    let stopWord = DEFAULT_STOP_WORD;
    let stopPrompt = DEFAULT_STOP_PROMPT;
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
    let completionCandidateSinceMs = 0;
    let userScrolledAway = false;
    let lastScrollTop = 0;

    // Состояние индикатора вкладки: 'working' (оранжевый), 'done' (зелёный), null (обычный)
    let tabIndicatorMode = null;
    let basePageTitle = null;
    let originalFaviconHrefs = [];
    let generatedFaviconLink = null;
    let titleObserver = null;
    let isUpdatingTitle = false;

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
            .replace(/^(?:🟠|🟢|\?\?)\s*\[(?:РАБОТАЕТ|ГОТОВО)\]\s*/u, '')
            .replace(/^(?:🟠|🟢)\s*/u, '')
            .trim();
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

    function buildBadgeFaviconDataUrl(mode) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;

            const isWorking = mode === 'working';
            const bgColor = isWorking ? '#ea580c' : '#16a34a';
            const ringColor = isWorking ? '#fdba74' : '#86efac';

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
                for (const cx of dots) {
                    ctx.beginPath();
                    ctx.arc(cx, 32, 4.5, 0, Math.PI * 2);
                    ctx.fill();
                }
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
            restoreOriginalFavicons();
            return;
        }

        if (originalFaviconHrefs.length === 0) {
            captureOriginalFavicons();
        }

        const dataUrl = buildBadgeFaviconDataUrl(mode);
        if (!dataUrl) return;

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
            nextTitle = `🟠 [РАБОТАЕТ] ${targetBase}`;
        } else if (mode === 'done') {
            nextTitle = `🟢 [ГОТОВО] ${targetBase}`;
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
        const normalizedMode = mode === 'working' || mode === 'done' ? mode : null;
        if (tabIndicatorMode === normalizedMode) {
            if (normalizedMode) {
                applyTitleMode(normalizedMode);
            }
            return;
        }
        tabIndicatorMode = normalizedMode;
        applyTitleMode(normalizedMode);
        applyFaviconMode(normalizedMode);
    }

    function startTitleGuard() {
        const titleEl = document.querySelector('title');
        if (!titleEl || titleObserver) return;

        titleObserver = new MutationObserver(() => {
            if (disposed || isUpdatingTitle || !tabIndicatorMode) return;
            const expectedPrefix = tabIndicatorMode === 'working' ? '🟠 [РАБОТАЕТ]' : '🟢 [ГОТОВО]';
            if (!document.title.startsWith(expectedPrefix)) {
                applyTitleMode(tabIndicatorMode);
            }
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
        collapseBtnEl.title = collapsed ? 'Развернуть виджет' : 'Свернуть виджет в компактный размер';

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
            return `${hours}ч ${String(minutes).padStart(2, '0')}м ${String(seconds).padStart(2, '0')}с`;
        }
        if (minutes > 0) {
            return `${minutes}м ${String(seconds).padStart(2, '0')}с`;
        }
        return `${seconds}с`;
    }

    function resetSessionStats(keepEnabledStart) {
        sessionCount = 0;
        cycleDurationsMs = [];
        cycleStartMs = Date.now();
        enabledSinceMs = keepEnabledStart ? Date.now() : null;
    }

    function getChatConfig(chatKey) {
        const defaults = loadJSON(STORAGE_DEFAULTS_KEY, {
            enabled: true,
            prompt: DEFAULT_CONTINUE_TEXT,
            stopPrompt: DEFAULT_STOP_PROMPT,
            stopWord: DEFAULT_STOP_WORD
        });
        const chats = loadJSON(STORAGE_CHATS_KEY, {});
        const saved = chats[chatKey] || {};

        return {
            enabled: typeof saved.enabled === 'boolean' ? saved.enabled : Boolean(defaults.enabled),
            prompt:
                typeof saved.prompt === 'string' && saved.prompt.trim().length > 0
                    ? saved.prompt
                    : (typeof defaults.prompt === 'string' && defaults.prompt.trim().length > 0
                        ? defaults.prompt
                        : DEFAULT_CONTINUE_TEXT),
            stopPrompt:
                typeof saved.stopPrompt === 'string'
                    ? saved.stopPrompt
                    : (typeof defaults.stopPrompt === 'string'
                        ? defaults.stopPrompt
                        : DEFAULT_STOP_PROMPT),
            stopWord:
                typeof saved.stopWord === 'string'
                    ? saved.stopWord.trim()
                    : (typeof defaults.stopWord === 'string'
                        ? defaults.stopWord.trim()
                        : DEFAULT_STOP_WORD),
            stats: saved.stats || null
        };
    }

    function saveChatConfig(chatKey, nextEnabled, nextPrompt, nextStopPrompt, nextStopWord, includeStats = true) {
        const cleanPrompt =
            typeof nextPrompt === 'string' && nextPrompt.trim().length > 0
                ? nextPrompt
                : DEFAULT_CONTINUE_TEXT;
        const cleanStopPrompt =
            typeof nextStopPrompt === 'string'
                ? nextStopPrompt
                : '';
        const cleanStopWord =
            typeof nextStopWord === 'string'
                ? nextStopWord.trim()
                : '';

        const chats = loadJSON(STORAGE_CHATS_KEY, {});
        const prev = chats[chatKey] || {};
        chats[chatKey] = {
            enabled: Boolean(nextEnabled),
            prompt: cleanPrompt,
            stopPrompt: cleanStopPrompt,
            stopWord: cleanStopWord,
            stats: includeStats
                ? {
                      sessionCount,
                      enabledSinceMs,
                      cycleDurationsMs
                  }
                : (prev.stats || null)
        };
        saveJSON(STORAGE_CHATS_KEY, chats);

        saveJSON(STORAGE_DEFAULTS_KEY, {
            enabled: Boolean(nextEnabled),
            prompt: cleanPrompt,
            stopPrompt: cleanStopPrompt,
            stopWord: cleanStopWord
        });
    }

    function syncStateWithCurrentChat(force = false) {
        const nextKey = getConversationKey();
        if (!force && nextKey === currentChatKey) return;

        currentChatKey = nextKey;
        const cfg = getChatConfig(currentChatKey);
        enabled = cfg.enabled;
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
        setTabIndicator(null);

        if (cfg.stats) {
            sessionCount = Number(cfg.stats.sessionCount) || 0;
            enabledSinceMs = typeof cfg.stats.enabledSinceMs === 'number' ? cfg.stats.enabledSinceMs : (enabled ? Date.now() : null);
            cycleDurationsMs = Array.isArray(cfg.stats.cycleDurationsMs) ? cfg.stats.cycleDurationsMs : [];
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
        const candidates = [
            ...(root ? root.querySelectorAll('button') : []),
            ...document.querySelectorAll(
                'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Остановить"]'
            )
        ];

        for (const btn of candidates) {
            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const compStop = btn.getAttribute('data-composer-stop');

            const isStop = compStop === 'true' || testId.includes('stop') ||
                aria.includes('остановить') || aria.includes('stop');
            if (isStop && btn.isConnected && !btn.closest('[hidden]') &&
                window.getComputedStyle(btn).display !== 'none' &&
                window.getComputedStyle(btn).visibility !== 'hidden') {
                return btn;
            }
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

    function isAssistantStreamingNow() {
        const turns = getAssistantElements();
        const lastTurn = turns[turns.length - 1];
        // Do not infer completion from a lack of text changes. Reasoning and tool
        // calls may cause long pauses with the real Stop button still visible.
        return Boolean(getStopButton()) || Boolean(lastTurn && (
            lastTurn.getAttribute('data-is-streaming') === 'true' ||
            lastTurn.getAttribute('aria-busy') === 'true'
        ));
    }

    // Resolve the sidebar indicator for THIS conversation only. A spinner in a
    // different chat must never block this one. The row can disappear when the
    // sidebar is collapsed or virtualized; that means "unknown", not "idle".
    function getCurrentSidebarGenerationState() {
        const match = getConversationKey().match(/^chat:([a-zA-Z0-9_-]+)$/);
        if (!match) return 'unknown';

        const chatId = match[1];
        const row =
            document.querySelector(`[data-sidebar-archive-chatgpt-id="${chatId}"]`) ||
            document.querySelector(`[data-sidebar-chatgpt-conversation-key="chatgpt:conversation:${chatId}"]`);
        if (!row) return 'unknown';

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
        const composer = isAssistantStreamingNow();
        return {
            sidebar,
            composer,
            active: sidebar === 'working' || composer
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
        const explicitSend =
            root.querySelector('button[data-testid="send-button"]') ||
            root.querySelector('button[data-composer-submit="true"]') ||
            root.querySelector('button[aria-label*="Отправить"]') ||
            root.querySelector('button[aria-label*="Send"]');

        if (explicitSend) return explicitSend;

        const trailingPrimary = root.querySelector(
            '[data-composer-trailing-controls="true"] button.bg-composer-primary:not([data-composer-voice-start="true"])'
        );
        return trailingPrimary || null;
    }

    function setStatus(text, state = 'idle') {
        if (!statusBadgeEl) return;

        statusBadgeEl.textContent = text;
        statusBadgeEl.dataset.state = state;

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
        scrollBtnEl.title = autoScrollEnabled
            ? 'Автоскролл включён (нажмите, чтобы выключить)'
            : 'Автоскролл выключен (нажмите, чтобы включить)';
        scrollBtnEl.style.opacity = autoScrollEnabled ? '1' : '0.55';
        scrollBtnEl.style.borderColor = autoScrollEnabled
            ? 'rgba(59, 130, 246, 0.5)'
            : 'rgba(148, 163, 184, 0.25)';
    }

    function updateSoundUI() {
        if (!soundBtnEl) return;
        soundBtnEl.textContent = soundEnabled ? '🔊' : '🔇';
        soundBtnEl.title = soundEnabled
            ? 'Звук включён (нажмите, чтобы выключить)'
            : 'Звук выключен (нажмите, чтобы включить)';
        soundBtnEl.style.opacity = soundEnabled ? '1' : '0.6';
    }

    function updateStatsUI() {
        if (compactCountEl) {
            compactCountEl.textContent = `${sessionCount}x`;
        }
        if (!statsEl) return;

        const now = Date.now();
        const elapsedStr = enabled && enabledSinceMs ? formatDuration(now - enabledSinceMs) : '0с';
        const avgMs =
            cycleDurationsMs.length > 0
                ? cycleDurationsMs.reduce((acc, v) => acc + v, 0) / cycleDurationsMs.length
                : null;
        const avgStr = avgMs !== null ? formatDuration(avgMs) : '-';
        const stopWordDisplay = stopWord ? stopWord : 'откл';

        // The marker is user-editable; inserting it into innerHTML is unsafe.
        const row1 = document.createElement('div');
        row1.textContent = `Продолжений: ${sessionCount} · Стоп: ${stopWordDisplay}`;
        const row2 = document.createElement('div');
        row2.textContent = `Прошло: ${elapsedStr} · Среднее: ${avgStr}`;
        statsEl.replaceChildren(row1, row2);
    }

    function updateToggleUI() {
        if (!toggleBtnEl) return;
        toggleBtnEl.textContent = enabled ? 'Вкл' : 'Выкл';
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

    function setComposerText(el, value) {
        if (!el || !el.isConnected || getComposerText(el).trim()) return false;
        el.focus();

        if (typeof el.value === 'string') {
            const prototype = el.tagName === 'TEXTAREA'
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return el.value === value;
        }

        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        // execCommand is deprecated, but still triggers the ProseMirror edit
        // pipeline in Chromium; a direct innerHTML assignment does not.
        try {
            const inserted = document.execCommand('insertText', false, value);
            return Boolean(inserted) && normalizeText(getComposerText(el)) === normalizeText(value);
        } catch (_) {
            return false;
        }
    }

    function triggerSend() {
        const sendBtn = getSendButton();
        if (!sendBtn || !sendBtn.isConnected || sendBtn.disabled ||
            sendBtn.getAttribute('aria-disabled') === 'true') return false;
        try {
            sendBtn.click();
            return true;
        } catch (_) {
            return false;
        }
    }

    function getActivePromptText() {
        const raw = promptInputEl ? promptInputEl.value : continueText;
        return typeof raw === 'string' && raw.trim().length > 0 ? raw : DEFAULT_CONTINUE_TEXT;
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
        saveChatConfig(
            currentChatKey,
            enabled,
            getActivePromptText(),
            getActiveStopPromptText(),
            getActiveStopWord(),
            includeStats
        );
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
        hasCompletedOnce = true;
        setTabIndicator('done');
        if (disableAutoContinue) {
            enabled = false;
            enabledSinceMs = null;
            persistCurrentSettings(true);
        }
        updateToggleUI();
        setStatus('Стоп-слово', 'stop');
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

    function runContinueNow(forceSend = false) {
        if (disposed || isSubmitting || awaitingReply || getGenerationSignals().active ||
            (!forceSend && !enabled)) return;
        const word = getActiveStopWord();
        if (!forceSend && hasStopWordInLastReply(word)) {
            triggerStopWordDetected(true);
            return;
        }

        const input = getComposerInput();
        if (!input) {
            setStatus('Поле ввода не найдено', 'stop');
            return;
        }
        if (getComposerText(input).trim()) {
            setStatus('Черновик не пуст — отправка отменена', 'stop');
            return;
        }

        const textToSend = buildFullPrompt(
            getActivePromptText(), getActiveStopPromptText(), word
        );
        if (!textToSend.trim() || !setComposerText(input, textToSend)) {
            setStatus('Не удалось заполнить поле ввода', 'stop');
            return;
        }

        const chatKeyAtStart = currentChatKey;
        pendingOwnedDraft = { input, text: textToSend, chatKey: chatKeyAtStart };
        const token = ++pendingSubmitToken;
        isSubmitting = true;
        setStatus('Отправка...', 'send');
        setTabIndicator('working');
        const startedAt = Date.now();

        const attemptSend = () => {
            if (disposed || token !== pendingSubmitToken ||
                getConversationKey() !== chatKeyAtStart ||
                (!forceSend && !enabled) || getGenerationSignals().active) {
                cancelPendingSend();
                return;
            }
            // The user may have modified the draft while waiting.
            if (normalizeText(getComposerText(input)) !== normalizeText(textToSend)) {
                cancelPendingSend();
                setStatus('Черновик изменён — отправка отменена', 'stop');
                return;
            }

            const assistantCount = getAssistantElements().length;
            if (triggerSend()) {
                pendingOwnedDraft = null;
                completionCandidateSinceMs = 0;
                hasCompletedOnce = false;
                submittedAssistantCount = assistantCount;
                submittedAtMs = Date.now();
                awaitingReply = true;
                wasGenerating = false;
                stopNotifiedForCurrentReply = false;
                recordContinuationSent();
                playTickSound();
                isSubmitting = false;
                pendingSubmitTimerId = null;
                setStatus('Ожидание ответа...', 'idle');
                return;
            }
            if (Date.now() - startedAt >= SEND_READY_TIMEOUT_MS) {
                cancelPendingSend();
                setStatus('Кнопка отправки недоступна', 'stop');
                return;
            }
            pendingSubmitTimerId = setTimeout(attemptSend, 200);
        };
        pendingSubmitTimerId = setTimeout(attemptSend, SUBMIT_DELAY_MS);
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

        const topRow = document.createElement('div');
        topRow.style.cssText = 'display: flex; align-items: center; gap: 5px; justify-content: space-between;';

        const dragHandle = document.createElement('span');
        dragHandle.title = 'Перетащить панель';
        dragHandle.textContent = '⠿';
        dragHandle.style.cssText = 'cursor: grab; color: #94a3b8; font-size: 13px; padding: 0 2px;';

        statusBadgeEl = document.createElement('span');
        statusBadgeEl.style.cssText = [
            'padding: 4px 7px',
            'border-radius: 999px',
            'font-size: 11px',
            'font-weight: 500',
            'white-space: nowrap',
            'margin-right: auto'
        ].join(';');

        compactCountEl = document.createElement('span');
        compactCountEl.title = 'Число продолжений в текущем чате';
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
        sendNowBtnEl.title = 'Отправить промпт сейчас';
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
            ensureAudioContext();
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
        promptInputEl.placeholder = 'Промпт для продолжения...';

        promptInputEl.title = 'Базовый промпт (поддерживает несколько строк; к нему добавится стоп-промпт)';
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
        resetPromptBtn.title = 'Сбросить промпт, стоп-промпт и стоп-слово';
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
            continueText = DEFAULT_CONTINUE_TEXT;
            stopPrompt = DEFAULT_STOP_PROMPT;
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
        stopPromptLabel.textContent = 'Стоп-промпт (поддерживает {STOP_WORD}):';
        stopPromptLabel.style.cssText = 'font-size: 10px; color: #94a3b8;';

        stopPromptInputEl = document.createElement('textarea');
        stopPromptInputEl.rows = 2;
        stopPromptInputEl.placeholder = 'Правило остановки...';
        stopPromptInputEl.title = 'Инструкция об условиях вывода стоп-слова (сохраняется для каждого чата)';
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
        stopLabel.textContent = 'Стоп-слово:';
        stopLabel.style.cssText = 'white-space: nowrap;';

        stopWordInputEl = document.createElement('input');
        stopWordInputEl.type = 'text';
        stopWordInputEl.placeholder = 'STOP_IT';
        stopWordInputEl.title = 'Если агент выведет это слово, сработает звуковой сигнал и автопродолжение выключится';
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
        bodyContainerEl.appendChild(statsEl);

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
            setTabIndicator('working');
            updateStatsUI();
            return;
        }

        const signals = getGenerationSignals();
        const now = Date.now();

        // A new assistant message confirms a successfully submitted continuation.
        // Sidebar activity alone is not proof that the new message was accepted.
        if (awaitingReply && getAssistantElements().length > submittedAssistantCount) {
            awaitingReply = false;
            wasGenerating = true;
        }

        if (signals.active) {
            completionCandidateSinceMs = 0;
            if (!wasGenerating) {
                stopNotifiedForCurrentReply = false;
            }
            wasGenerating = true;
            setTabIndicator('working');
            setStatus(signals.sidebar === 'working' ? 'Генерация · чат' : 'Генерация...', 'gen');
            performAutoScroll();
            updateStatsUI();
            return;
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
                setTabIndicator(null);
                setStatus('Нет ответа — выкл', 'stop');
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
        if (e.key === STORAGE_CHATS_KEY || e.key === STORAGE_DEFAULTS_KEY) {
            syncStateWithCurrentChat(true);
        }
    };
    window.addEventListener('storage', onStorage);
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