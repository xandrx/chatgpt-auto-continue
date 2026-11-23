# ChatGPT Auto Continue

**Language:** English | [Русский](README.ru.md)

A **Tampermonkey userscript** that automatically continues a [ChatGPT](https://chatgpt.com/) conversation once the assistant has finished responding. It provides a compact floating control panel, configurable stop word, session statistics, and safeguards against sending a follow-up while a response is still being generated.

**Current version:** 1.20  
**Interface language:** Russian  
**Supported website:** `https://chatgpt.com/*`

> This is an unofficial project and is not affiliated with OpenAI. Automatically sending messages may consume your ChatGPT usage limits and continue an interaction without manual approval. Monitor its activity and avoid using it for unsupervised sensitive actions.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the [userscript file](https://github.com/xandrx/chatgpt-auto-continue/raw/refs/heads/main/chatgpt_auto_continue.user.js) and install it through Tampermonkey. If your browser displays the source code instead, create a new userscript in Tampermonkey and paste the code manually.
3. Open or refresh [ChatGPT](https://chatgpt.com/).
4. Find the **ChatGPT Auto Continue** floating panel.

## Features

- **Automatic continuation:** Sends your configured message after the assistant's response is confirmed complete. The default prompt is `Продолжай` (“Continue”).
- **False-completion protection (v1.19):** Detects active generation using the Stop button, assistant response attributes, and the **current conversation's** sidebar indicator (`data-sidebar-indicator="working"`).
- **Stable completion check:** Waits **5 seconds** after all generation indicators disappear, or **10 seconds** if the conversation row is unavailable in the sidebar. If generation resumes, the timer resets.
- **Duplicate-send prevention:** Rechecks generation immediately before sending. If generation resumes, it cancels the prepared draft as long as the user has not edited it.
- **Response confirmation:** Does not start another cycle until a new response to the previous message is confirmed. If the response times out, automatic mode is disabled.
- **Stop word:** Watches for a marker **in the assistant's latest reply**. On detection, it disables automatic continuation and plays a notification sound. Default: `STOP_IT`.
- **Stop instruction:** Appends configurable stopping criteria to the continuation prompt. The `{STOP_WORD}` placeholder is replaced with the configured marker.
- **Floating panel:** Enable/disable automation, manually send a message, collapse the panel, drag it, and save its position.
- **Auto-scroll:** Follows new messages while respecting manual scrolling.
- **Browser tab indicator:** Changes the tab title and favicon during generation and upon completion.
- **Sounds and statistics:** Notification sounds, continuation counter, elapsed time, and average cycle duration.
- **Per-conversation preferences:** Stores chat-specific settings in the browser using `localStorage`.

## How to use

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

This userscript depends on ChatGPT's current DOM structure. UI changes may require selector updates. If the sidebar conversation row is missing from the DOM, the script falls back to other activity signals and a longer confirmation delay. Background tabs may be polled less frequently due to browser throttling. Syntax and simulated-state checks are not substitutes for testing against the live interface.

## License

No license has been specified for the repository yet. If you want to permit reuse, modification, and redistribution, add a `LICENSE` file (for example, MIT).
