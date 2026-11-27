# MV3 browser end-to-end acceptance

Status: **not yet run**. CI's Node VM test validates the extension background message boundary; it does not emulate Chromium cookie policy, extension Origin, tabs, background scheduling or ChatGPT's live DOM.

## Test environment
- Dedicated Windows workstation, current Chrome or Edge, Rust release binary on the same machine.
- Disposable ChatGPT account/conversations; no personal or production chats.
- Dispatcher bound only to `127.0.0.1:8766`; temporary SQLite database and fresh random admin token.
- Load unpacked from `dispatcher/extension`. Configure the exact popup origin as `DISPATCHER_EXTENSION_ORIGIN` and restart.
- Do not expose the port through a tunnel, reverse proxy or LAN listener.

## Acceptance matrix
1. **Install and origin** — load unpacked; popup displays the extension origin. Configure it exactly. An OPTIONS preflight from that origin succeeds; a different origin receives 403. No wildcard CORS.
2. **Enrollment** — register one disposable saved conversation. Server returns session metadata and a path-scoped HttpOnly/Secure cookie, never the raw session credential in JSON. Inspect extension storage: only the generated session ID and metadata are present. Verify cookie is not readable from page JavaScript.
3. **Least privilege** — the cookie works for that session's heartbeat/wait/ack only. It cannot list sessions, enqueue, revoke, inspect another session, or call either MCP endpoint.
4. **Default off** — immediately after enrollment, no queue long-poll occurs. Only after manually enabling that conversation does it heartbeat and poll.
5. **Harmless dispatch** — queue a harmless text-only fixture. With the target tab idle and composer empty, it is inserted and sent exactly once. The server observes submitted, then completed only after a new assistant response and a quiet interval.
6. **User draft protection** — type a draft, then queue a fixture. No text is overwritten and no send occurs. The job is failed/reviewable; the draft remains intact.
7. **Busy protection** — while generating, while an unanswered user turn exists, and while an error/limit alert is visible, no queued prompt is sent.
8. **Duplicate tabs** — open the same conversation in two tabs. Confirm fencing prevents both from independently receiving/sending; record which tab owns the lease. No duplicate prompt.
9. **SPA navigation** — navigate from conversation A to B while polling, while a prompt is prepared in the composer, and after a send click. No task for A is sent into B. Ambiguous post-click state is uncertain, never retried.
10. **Network and restart** — disconnect loopback before claim, after claim, after click, and before acknowledgment; restart the dispatcher with queued and in-flight jobs. Queued unexpired work may survive; claimed/submitted work becomes uncertain and must not auto-replay.
11. **Export gate** — with export disabled, completed result text is not sent to the server. With export enabled at registration, only the final assistant text is exported, bounded by the client limit.
12. **Revocation** — revoke the session server-side while the tab is enabled. The first rejected heartbeat/wait must disable remote polling locally, persist a revoked marker, and show an actionable popup state. The unique chat binding cannot silently re-enroll or rebind; administrator recovery is required.

## Release gate
Do not enable remote tasks in real working conversations until all applicable tests pass on both Chrome and Edge. Keep the feature disabled by default. Record browser version, extension version, OS, each result and any DOM selector adjustments. A successful CI run is not a substitute for this matrix.
