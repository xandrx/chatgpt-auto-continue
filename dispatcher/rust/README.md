# Session Dispatcher Rust core

Development only; independent from the preserved Python prototype. No live browser integration, MCP endpoint or production deployment yet.

Prerequisites: Rust stable with Cargo, a C toolchain for bundled SQLite (on Windows: Visual Studio Build Tools with MSVC C++ workload). From this directory:

    cargo fmt
    cargo test
    cargo build --release
    cargo run

Development status: Linux CI successfully built the release binary and passed all nine Rust tests and the loopback HTTP smoke test (run 45995556225, commit 8333842de95c). Rust and Cargo 1.100.0 are installed on the Windows development workstation. Local MSVC compilation requires the Visual Studio C++ toolchain, which is currently absent. CI is configured to test and build only, not deploy. The separate SQLite schema smoke test passes (run python tests/schema_smoke.py); Python is needed only for this optional development check.

Set DISPATCHER_ADMIN_TOKEN to a randomly generated value of at least 32 characters through the process environment; never commit it or use a shared sample credential. Optionally set DISPATCHER_DB (default dispatcher.sqlite3). The service binds exclusively to 127.0.0.1:8766.

API v1: GET /health; POST /v1/sessions (operator enrollment); GET /v1/sessions (operator list); POST /v1/sessions/{id}/revoke (operator); POST /v1/jobs (operator enqueue); GET /v1/jobs/{id}; POST /v1/jobs/{id}/cancel; POST /v1/sessions/{id}/heartbeat, /claim, /wait, /ack (session credential). Use Authorization: Bearer <credential>. Enrollment returns a unique session credential only once. Session actions must match the enrolled chat ID and worker; claim/ack require the current lease epoch.

No server-side action executes a task; it stores authorized text for an opted-in client. A claim is not evidence of delivery. Uncertain work blocks further delivery until explicitly reviewed. Operator-only GET/POST /v1/jobs/{id}/review provides audited resolution after the previous lease expires; no automatic replay. Server restart invalidates all previous leases, marks in-flight work uncertain, and retains unexpired queued work. Export disabled by default. Do not expose the development endpoint to the internet.

Long polling uses a bounded wait of up to 25 seconds with coalesced wake-up events and at most 256 pending requests; SQLite is released during the wait. See docs/DISPATCHER-PROTOCOL.md for details.

Tests exercise storage and state transitions without real ChatGPT, using an in-memory database. The CI additionally runs synthetic HTTP and Linux load smoke tests against the actual release binary in an isolated runner. Load tests enroll 10, 50, 100 and 500 sessions, with at most 100 simultaneous waits per batch, and record sampled RSS, one-second idle CPU and enqueue-to-claim latency. The 500-session case does not imply support for 500 simultaneous waits; the registry supports cursor pagination, up to 200 rows per page. Follow docs/DISPATCHER-PLAN.md before integrating live clients.
