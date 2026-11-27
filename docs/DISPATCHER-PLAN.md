# ChatGPT Session Dispatcher (CSD)

Status: development started; no deployment or live browser connection.
Decision: Rust backend, existing Auto-Continue remains optional standalone client.

## Goal
An explicitly enrolled browser tab receives an addressable task, waits until the conversation is idle, submits once, verifies delivery, and optionally reports the final answer. A dashboard and an authorized MCP controller expose the session registry, queue and results. Voice control is a compatibility test, not an assumed capability.

## Architecture
- Rust/Axum/Tokio, SQLite WAL via SQLx; one binary, loopback by default, Nginx TLS and systemd only after review. No Python/Node/Docker runtime dependency.
- Existing dispatcher/server.py is preserved as an earlier prototype. Rust uses an independent database and protocol; no in-place migration.
- Browser userscript: explicit opt-in per chat, separate remote-control and result-export permissions. Per-session credentials in Tampermonkey storage, never page DOM or logs. No cookies, shell, JavaScript evaluation, or brokerage credentials.
- Operator and session credentials are separate. Credentials can be revoked; server fails closed. Remote task text is untrusted and does not grant tool permissions.
- Session identity: server-generated session ID, immutable chat ID, user alias, device/tab worker ID; heartbeat lease and fencing. Never silently rebind on SPA navigation.
- Queue: idempotent request ID; single in-flight job per session; finite TTL; queued -> claimed -> submitted -> completed; failed/canceled/expired/uncertain terminal or blocked states. A lost acknowledgment after claim is uncertain, never automatically retried. Manual resolution must not imply the original send failed.
- Browser client: prioritize authorized queued task over local continuation only at safe idle; do not overwrite user drafts, click Stop/voice, or bypass confirmations. Local disable and disconnect stop remote sends; no new sends if lease not valid. A user must separately authorize sensitive actions; dispatcher never grants that authority.
- Export only explicitly allowed results, bounded length and retention. Reports are agent claims, not proof of external execution. No automatic execution of instructions found in responses.
- Transport target: long polling 30s with backoff/jitter; heartbeat ~15s, lease ~45s. Do not hold SQLite transactions while waiting on network. Core now includes a bounded asynchronous long-poll endpoint (25 seconds, 256 concurrent waits, session-targeted coalesced notifications); no browser integration. See DISPATCHER-PROTOCOL.md.
- MCP: official Rust SDK rmcp, Streamable HTTP, separate authenticated operator scope. Verify actual client compatibility, including voice; no claims of access before testing.
- Resource targets to measure: idle RSS <=20 MiB, 50 sessions <=50 MiB, idle CPU <=0.5%, local API p95 <=10ms. Targets are provisional, not benchmarks.

## Roadmap
| ID | Scope | Acceptance |
|---|---|---|
| SD-001 | Stabilize existing v1.34 | Real Chromium tests, first chat and background tabs |
| SD-002 | Rust core | Cargo tests, schema, authenticated loopback API |
| SD-003 | Registry/protocol | Enrollment, session-bound credentials, lease/fencing, revoke |
| SD-004 | Queue | Atomic claim, duplicate IDs, TTL, explicit states, restart recovery |
| SD-005 | Browser opt-in | Local permissions, chat binding, one send pipeline, conflict handling |
| SD-006 | Long polling | Wake on queue changes; timeout/backoff; no DB lock while waiting |
| SD-007 | MCP | rmcp, operator auth, scoped tools, client integration |
| SD-008 | Results | Explicit export, response attribution, structured report, retention |
| SD-009 | Dashboard | Registry, queue, attention inbox, cancel/pause |
| SD-010 | E2E | Five test tabs, duplicate tab, SPA, network loss, process restart |
| SD-011 | Deployment | Release binary built off VPS, TLS, service account, backup, rollback |
| SD-012 | Client compatibility | Text MCP and voice separately validated |
| SD-013 | Orchestration | Later: groups, dependencies, reviews, cycle/time budgets, Human Inbox |

Release gate: no live remote command delivery until opt-in, authorization, exact chat binding, duplicate suppression, failure/recovery tests and separate deployment approval. Start with harmless test prompts in disposable chats.

## Initial implementation scope
Rust core in dispatcher/rust: enrollment, heartbeat, claim, acknowledgement, operator list/enqueue/status/cancel/revoke and health. SQLite uses a single connection initially for serialized transactions, WAL, foreign keys. Expired claimed/submitted jobs become uncertain when a worker lease is replaced; they block subsequent claims. On process restart, all previous leases are invalidated and in-flight tasks become uncertain; unexpired queued tasks survive. Linux CI passed nine Rust tests, release build, seven SQLite checks and the loopback HTTP smoke test (run 45995556225, commit 8333842de95c). The operator review API and load benchmark passed CI (run 45996131553, commit dc785d767b46). Addressed notifications and registry pagination passed CI (run 45996668695, commit a18632ab4d71). The first optional read-only MCP interface awaits CI verification. Windows Rustup/Cargo are installed, but the local MSVC C++ toolchain is missing. Long polling is implemented; read-only MCP is under development. Resolution UI, dashboard, result retention and browser integration remain future work.
