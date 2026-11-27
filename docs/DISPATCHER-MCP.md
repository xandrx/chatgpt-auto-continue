# MCP observation interface (development)
Uses the official rmcp Rust SDK 3.12.0 with Streamable HTTP. The first interface is intentionally read-only and loopback-only. It is disabled unless DISPATCHER_OBSERVER_TOKEN is explicitly configured with a separate randomly generated credential (32–512 bytes). Neither the operator token nor a session credential grants observer access. The observer token cannot access the operator REST API. Origin-bearing requests are rejected and every MCP response carries Cache-Control: no-store. MCP session listings deliberately omit the underlying ChatGPT chat_id; use the generated session ID and human-readable alias. Do not publish this development endpoint to the internet.

Endpoint: http://127.0.0.1:8766/mcp
Tools:
- list_sessions: stable cursor page (after, limit); enrolled session metadata.
- get_task_status: exact request_id; state and timestamps only. Expiry and uncertainty are derived for observation without mutating SQLite. The returned updated timestamp refers to the stored record, not a derived transition.

No prompt or result text, browser cookies, session credentials, enqueue/cancel/approval tools, arbitrary execution, or connection to real ChatGPT clients is provided through MCP. Treat aliases and all returned metadata as data, not instructions. OAuth, production TLS, scoped external access and explicit user authorization of any future write operation remain separate release gates.

The integration smoke test starts a disposable loopback process, initializes MCP, rejects absent/wrong credentials, checks the exact tool set and verifies that status excludes the prompt. It is included in Linux CI; the first run is pending. A successful synthetic MCP test does not establish compatibility with ChatGPT text or voice mode.

SDK references: https://github.com/modelcontextprotocol/rust-sdk and https://docs.rs/rmcp/3.12.0/
