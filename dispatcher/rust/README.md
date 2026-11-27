# Session Dispatcher Rust core

Development only; independent from the preserved Python prototype. No live browser integration, MCP endpoint or production deployment yet.

Prerequisites: Rust stable with Cargo, a C toolchain for bundled SQLite (on Windows: Visual Studio Build Tools with MSVC C++ workload). From this directory:

    cargo fmt
    cargo test
    cargo build --release
    cargo run

Development status: source has been saved, but Cargo is not installed on the current workstation. The Rust build and six Rust tests require Cargo or Linux CI; Cargo.lock must be generated and committed after the first successful build. CI is configured to test and build only, not deploy. The separate SQLite schema smoke test passes (run python tests/schema_smoke.py); Python is needed only for this optional development check.

Set DISPATCHER_ADMIN_TOKEN to a randomly generated value of at least 32 characters through the process environment; never commit it or use a shared sample credential. Optionally set DISPATCHER_DB (default dispatcher.sqlite3). The service binds exclusively to 127.0.0.1:8766.

API v1: GET /health; POST /v1/sessions (operator enrollment); GET /v1/sessions (operator list); POST /v1/sessions/{id}/revoke (operator); POST /v1/jobs (operator enqueue); GET /v1/jobs/{id}; POST /v1/jobs/{id}/cancel; POST /v1/sessions/{id}/heartbeat, /claim, /ack (session credential). Use Authorization: Bearer <credential>. Enrollment returns a unique session credential only once. Session actions must match the enrolled chat ID and worker; claim/ack require the current lease epoch.

No server-side action executes a task; it stores authorized text for an opted-in client. A claim is not evidence of delivery. Uncertain work blocks further delivery until reviewed (manual recovery endpoint is a future milestone). Server restart invalidates all previous leases, marks in-flight work uncertain, and retains unexpired queued work. Export disabled by default. Do not expose the development endpoint to the internet.

Tests exercise storage and state transitions without real ChatGPT, using an in-memory database. Follow docs/DISPATCHER-PLAN.md before integrating live clients.
