# MV3 browser end-to-end acceptance

Status: **not yet run**. CI's Node VM test validates the extension background message boundary; it does not emulate Chromium cookie policy, extension Origin, tabs, background scheduling or ChatGPT's live DOM.

## Test environment
- Dedicated Windows workstation, current Chrome or Edge, Rust release binary on the same machine.
- User's existing logged-in Chrome or Edge profile and one explicitly selected, saved real conversation. The user has authorized live-conversation testing.
- Dispatcher bound only to `127.0.0.1:8766`; production VPS SQLite and separate operator credentials.
- Load unpacked from `dispatcher/extension`. Configure the exact popup origin as `DISPATCHER_EXTENSION_ORIGIN` and restart.
- Keep all other conversations unregistered or remote-disabled. Do not expose admin/MCP routes or the listener through a tunnel, reverse proxy or LAN listener.
- The extension does not upload prior conversation history. It sends only session metadata and, when the user enables `Export final answers`, the final answer to a task dispatched through this system. Keep that export setting off unless the user wants to verify result return.

## Acceptance matrix
1. **Install and origin** — load unpacked; popup displays the extension origin. Configure it exactly. An OPTIONS preflight from that origin succeeds; a different origin receives 403. No wildcard CORS.
2. **Enrollment** — register one disposable saved conversation. Server returns session metadata and a path-scoped HttpOnly/Secure cookie, never the raw session credential in JSON. Inspect extension storage: only the generated session ID and metadata are present. Verify cookie is not readable from page JavaScript.
3. **Least privilege** — the cookie works for that session's heartbeat/wait/ack only. It cannot list sessions, enqueue, revoke, inspect another session, or call either MCP endpoint.
4. **Default off** — immediately after enrollment, no queue long-poll occurs. Only after manually enabling that conversation does it heartbeat and poll.
5. **Live dispatch** — in the selected real conversation, obtain user approval for the exact harmless test prompt before queueing it. With the target tab idle and composer empty, it is inserted and sent exactly once. The server observes submitted, then completed only after a new assistant response and a quiet interval. Never dispatch to every open tab or infer approval from a general request to test.
6. **User draft protection** — type a draft, then queue a fixture. No text is overwritten and no send occurs. The job is failed/reviewable; the draft remains intact.
7. **Busy protection** — while generating, while an unanswered user turn exists, and while an error/limit alert is visible, no queued prompt is sent.
8. **Duplicate tabs** — open the same conversation in two tabs. Confirm fencing prevents both from independently receiving/sending; record which tab owns the lease. No duplicate prompt.
9. **SPA navigation** — navigate from conversation A to B while polling, while a prompt is prepared in the composer, and after a send click. No task for A is sent into B. Ambiguous post-click state is uncertain, never retried.
10. **Network and restart** — disconnect loopback before claim, after claim, after click, and before acknowledgment; restart the dispatcher with queued and in-flight jobs. Queued unexpired work may survive; claimed/submitted work becomes uncertain and must not auto-replay.
11. **Export gate** — with export disabled, completed result text is not sent to the server. With export enabled at registration, only the final assistant text is exported, bounded by the client limit.
12. **Revocation** — revoke the session server-side while the tab is enabled. The first rejected heartbeat/wait must disable remote polling locally, persist a revoked marker, and show an actionable popup state. The unique chat binding cannot silently re-enroll or rebind; administrator recovery is required.

## Live pilot and release gate
A narrowly scoped live pilot is authorized for one user-selected real conversation and one explicitly approved harmless prompt. Register only that conversation; keep `Accept remote tasks` off until ready; enable `Export final answers` only if the user wants to verify response return. Confirm the result, disable remote tasks again, and record browser version, extension version, OS and observed states. Do not enroll or enable all real conversations. Do not broaden the pilot to multiple chats or unattended dispatch until the remaining applicable matrix passes on Chrome and Edge. A successful CI run is not a substitute for this matrix.
