# ChatGPT Session Dispatcher — Chrome/Edge extension

This MV3 extension is the browser client for the Rust dispatcher. It is separate from the Auto-Continue userscript so the page never receives the server's per-session authorization material.

## Local setup

1. Build and run the Rust dispatcher on the same Windows computer as the browser. It listens only on `127.0.0.1:8766`.
2. Open `chrome://extensions` or `edge://extensions`, enable Developer mode and choose **Load unpacked**.
3. Select this `dispatcher/extension` folder.
4. Open the extension popup and copy the displayed origin, `chrome-extension://<32-character-id>`.
5. Set that exact value in the server process environment as `DISPATCHER_EXTENSION_ORIGIN`, then restart the dispatcher.
6. Open a saved ChatGPT conversation, open the extension popup and choose **Register this chat**.
7. Choose whether final answers may be exported. This choice is fixed at registration.
8. Enable **Accept remote tasks** only in chats that should receive remote work.

The optional `DISPATCHER_ENROLL_TOKEN` remains available for non-extension clients. The extension itself uses the exact extension Origin allowlist and does not store an enrollment token.

## Security model

- The service remains loopback-only. Do not expose port 8766 through a public reverse proxy or tunnel.
- The background service worker makes requests to the local API. The content script cannot read session authorization.
- Enrollment returns session metadata plus a path-scoped `HttpOnly; Secure; SameSite=None` cookie. The browser sends it automatically; JavaScript cannot read it.
- The cookie path is limited to that session's `/v1/sessions/<id>` endpoints. It cannot list sessions, enqueue jobs, revoke sessions or call the operator API.
- The server accepts extension requests only from the exact configured `DISPATCHER_EXTENSION_ORIGIN`. CORS preflight is restricted to that origin.
- Remote work is off by default and is enabled separately per conversation. A non-empty composer, active generation, unanswered user turn or visible error prevents a new claim.
- A claimed task is sent once. If submission or completion cannot be confirmed, the client reports `uncertain`; it never retries the prompt automatically.
- Answer export is off by default and can only be selected during registration. When disabled, the background service worker sends an empty result.

## Current limitations

This is an initial development client. Real Chromium/Edge end-to-end testing is still required for private-network permission prompts, cookie acceptance on loopback, ChatGPT DOM selector changes, background-tab throttling, reload/navigation recovery and long-running responses. Keep it on harmless test prompts until those tests pass. No VPS deployment is configured.
