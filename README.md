# ChatGPT Auto Continue

**Language:** English | [Русский](README.ru.md)

A **Tampermonkey userscript** that automatically continues a [ChatGPT](https://chatgpt.com/) conversation once the assistant has finished responding. It provides a compact floating control panel, configurable stop word, session statistics, and safeguards against sending a follow-up while a response is still being generated.

**Current version:** 1.32  
**Interface language:** English (default) / Russian  
**Supported website:** `https://chatgpt.com/*`

> This is an unofficial project and is not affiliated with OpenAI. Automatically sending messages may consume your ChatGPT usage limits and continue an interaction without manual approval. Monitor its activity and avoid using it for unsupervised sensitive actions.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the [userscript file](https://github.com/xandrx/chatgpt-auto-continue/raw/refs/heads/main/chatgpt_auto_continue.user.js) and install it through Tampermonkey. If your browser displays the source code instead, create a new userscript in Tampermonkey and paste the code manually.
3. Open or refresh [ChatGPT](https://chatgpt.com/).
4. Find the **ChatGPT Auto Continue** floating panel.

## Features

- **Automatic continuation:** Sends your configured message after the assistant's response is confirmed complete. The default prompt is `Continue` in English and `Продолжай` in Russian.
- **False-completion protection (v1.19):** Detects active generation using the Stop button, assistant response attributes, and the **current conversation's** sidebar indicator (`data-sidebar-indicator="working"`).
- **Stable completion check:** Waits **5 seconds** after all generation indicators disappear, or **10 seconds** if the conversation row is unavailable in the sidebar. If generation resumes, the timer resets.
- **Duplicate-send prevention:** Rechecks generation immediately before sending. If generation resumes, it cancels the prepared draft as long as the user has not edited it.
- **Response confirmation:** Does not start another cycle until a new response to the previous message is confirmed. If the response times out, automatic mode is disabled.
- **Stop word:** Watches for a marker **in the assistant's latest reply**. On detection, it disables automatic continuation and plays a notification sound. Default: `STOP_IT`.
- **Stop instruction:** Appends configurable stopping criteria to the continuation prompt. The `{STOP_WORD}` placeholder is replaced with the configured marker.
- **Floating panel:** Enable/disable automation, manually send a message, collapse the panel, drag it, and save its position.
- **Auto-scroll:** Follows new messages while respecting manual scrolling.
- **Browser tab indicator:** Shows elapsed request time (`[MM:SS]` or `[HH:MM:SS]`), an orange favicon with animated dots when assistant content changes, and a green completion check. The completion badge clears after three seconds of continuous foreground focus.
- **Sounds and statistics:** Notification sounds, continuation counter, elapsed time, and average cycle duration.
- **Independent tabs (v1.21):** Each tab keeps its own on/off state and continuation statistics in `sessionStorage`, per conversation. Enabling a chat in one tab does not enable it in another separately opened tab.
- **Shared prompt preferences:** Prompt text, stop instructions, and stop words remain stored per conversation in `localStorage`; changes to these preferences no longer reset another tab's generation or pending submission.

## How to use

Select English or Russian in the **Interface language** field. The preference is shared across tabs; switching does not overwrite saved prompts or interrupt the current cycle. The reset button restores defaults in the selected language.

1. In the panel, keep or customize the **continuation prompt**.
2. Optionally configure the **stop instruction** and **stop word**.
3. Switch automation **on** (the Russian button reads **Вкл**). Once ChatGPT finishes the response and activity indicators remain absent for the confirmation period, the script sends the next prompt.
4. Switch it **off** (**Выкл**) to stop automatic continuation. The **▶** button sends the prompt manually, subject to the same generation safety checks.

The script is designed not to overwrite text you have already entered in ChatGPT's composer.

## Automatic updates

The userscript includes stable URLs pointing to the `main` branch:

```javascript
// @updateURL    https://raw.githubusercontent.com/xandrx/chatgpt-auto-continue/main/chatgpt_auto_continue.user.js
// @downloadURL  https://raw.githubusercontent.com/xandrx/chatgpt-auto-continue/main/chatgpt_auto_continue.user.js
```

For future releases, increase the userscript's `@version`, update the file **without changing its name**, and let Tampermonkey check for updates (or trigger the check manually).

**Migrating from the old Gist:** Existing installations pointing to the Gist do not automatically switch update sources. Install the script from this repository once to receive subsequent updates here.

## Project structure

```text
chatgpt-auto-continue/
├── chatgpt_auto_continue.user.js  # Tampermonkey userscript
├── README.md                      # English documentation (default)
└── README.ru.md                   # Russian documentation
```

## Changelog

### v1.26 — Actionable tab alerts

- Added yellow stop, quota and verification badges (`[СТОП]`, `[ЛИМИТ]`, `[ПРОВЕРКА]`) and a red error badge (`[ОШИБКА]`).
- Reports stop words, stale generation flags, submission failures, unconfirmed responses and conflicting drafts.
- Detects recognizable English and Russian quota/error messages in explicit visible ChatGPT UI alerts, not ordinary assistant text. Detection is best-effort and depends on the current interface.
- Explicit ChatGPT failures pause automation instead of sending another prompt. Strong generation signals retain priority.
- Notices clear from the tab title and favicon after three seconds of continuous foreground focus. A persistent identical alert does not rearm its badge; the reason remains in the panel until a new attempt or generation.

### v1.25 — Informative browser tabs

- Replaced `[РАБОТАЕТ]` with a compact elapsed request timer (`[MM:SS]`, or `[HH:MM:SS]` for long requests). Each new request starts a new timer; manually initiated requests are timed from their first detection.
- Animated the orange favicon only when changes in the latest assistant response are observed in the DOM. It returns to a steady icon after 2.4 seconds without observed updates. Silence is not a completion signal.
- Removed redundant colored emoji from the title; color is represented by the favicon.
- Automatically clears `[ГОТОВО]` and restores the normal favicon after three seconds of continuous visible, focused tab activity. Switching away resets the read delay; a new request resets the badge and timer.
- Browser throttling may delay title and favicon updates in background tabs. The read badge is local to this userscript and does not alter ChatGPT's own unread state.

### v1.24 — Stuck generation signal recovery

- Replaced broad Stop-button matching with precise composer button labels/test IDs and visibility checks. Unrelated controls and hidden buttons no longer count as an active generation.
- Added source-specific status text: `Генерация · чат` (sidebar), `Генерация · Stop` (Stop button), and `Генерация · busy` (assistant reply attribute). Hover over the status badge to inspect the detected signals.
- Detects a lingering `aria-busy` / `data-is-streaming` flag when neither Stop nor the sidebar confirms generation and the response text is unchanged: after **45 seconds** with an idle sidebar and editable composer, or **120 seconds** with insufficient corroboration.
- **Fail-safe:** ambiguous stale flags pause auto-continuation and display `Зависший busy · проверка`; the script does **not** send a new message automatically after a manually stopped or uncertain response.
- The sidebar's `working` indicator and a real Stop button still take priority, regardless of elapsed time.

### v1.21

- Fixed on/off state unexpectedly propagating between ChatGPT tabs.
- Moved the enabled flag and session statistics out of shared `localStorage` and into tab-scoped `sessionStorage` (separately for each conversation).
- Prevented cross-tab storage events from resetting pending submissions or generation tracking.
- Removed legacy shared enabled/statistics properties on the next settings save.
- For safety, previously shared enabled flags are **not migrated**: enable auto-continue manually in each tab after updating.

### v1.20

- Fixed a failure to populate the ChatGPT prompt field when using the manual **▶** button or automatic continuation.
- Added clipboard paste and HTML insertion fallbacks for contenteditable / ProseMirror editors.
- Confirmed success by inspecting editor text instead of trusting the deprecated `execCommand` return value.
- Preserved the existing generation-in-progress and duplicate-send safeguards.

### v1.19

- Added detection of the active chat's generation indicator in the sidebar.
- Added completion confirmation delays of 5 or 10 seconds, depending on sidebar availability.
- Improved protection against sending another message when the Send button appears briefly during an ongoing response.
- Added cancellation of the script-prepared draft when generation resumes.
- Improved handling of an unconfirmed response.

## Limitations

The script cannot determine from DOM attributes alone whether a response was manually stopped. If a stale `busy` signal is detected, verify the conversation before turning automation back on. If the sidebar still marks the conversation as `working`, the script conservatively waits rather than assuming completion.

This userscript depends on ChatGPT's current DOM structure. UI changes may require selector updates. If the sidebar conversation row is missing from the DOM, the script falls back to other activity signals and a longer confirmation delay. Background tabs may be polled less frequently due to browser throttling. Syntax and simulated-state checks are not substitutes for testing against the live interface.

## License

No license has been specified for the repository yet. If you want to permit reuse, modification, and redistribution, add a `LICENSE` file (for example, MIT).
