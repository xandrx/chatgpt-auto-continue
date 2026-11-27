# MCP operator interface — two-phase task dispatch

The observer endpoint remains read-only at `/mcp` and uses `DISPATCHER_OBSERVER_TOKEN`.

The separately credentialed operator endpoint is `/mcp/operator` and is disabled unless `DISPATCHER_MCP_OPERATOR_TOKEN` is configured. This token must be 32–512 bytes and distinct from the REST admin token, observer token and every session credential. It cannot call the REST admin API. Both MCP endpoints bind only to the existing loopback listener, reject requests carrying an Origin header and add `Cache-Control: no-store`. Do not expose either endpoint through a public reverse proxy or tunnel in this development stage.

## Tools
- `list_sessions`: registry metadata, alias and generated session ID; never returns the ChatGPT chat_id or credentials.
- `get_task_status`: exact request ID; state and timestamps only, no prompt or result.
- `prepare_task(session_id,prompt,ttl_seconds)`: validates the target and creates a pending approval. It does not create a queue job. Returns the exact prompt for review, target alias, online/status information, generated approval ID and expiry.
- `confirm_task(approval_id,user_confirmed)`: queues only when user_confirmed is true. The assistant must call this only after the user explicitly approves the exact prompt returned by prepare_task in the current conversation. The MCP server cannot independently authenticate the human conversation; this is a tool-use contract, not cryptographic proof of user intent.
- `cancel_prepared_task(approval_id)`: cancels a pending approval; cannot cancel an already queued job.

## Approval semantics
Approvals are persisted in SQLite and expire after 120 seconds. One pending approval per session is allowed. Preparation is rejected when the session already has a queued, claimed, submitted or uncertain task. Confirmation rechecks that the session remains enabled and no other task is queued or unresolved.

The approval and queue insertion are committed in one transaction. The request ID is generated at preparation time. Repeating confirm after a lost MCP response returns the same job receipt; it never creates a second job. A prepared task is not queued until confirmation. Cancellation and expiry scrub the stored prompt. Successful confirmation moves the prompt into the normal jobs table and clears the duplicate approval copy. Restart preserves pending approvals and their expiry, but clients still need a valid live lease to claim jobs.

The returned receipt means only that the server queued the text. It does not mean a browser sent it or that ChatGPT executed it. A lost worker acknowledgment remains uncertain and must be reviewed; never automatically replay it.

## Test scope
The synthetic MCP integration test exercises separate observer/operator/admin/session credentials, exact tool inventory, prepare-without-enqueue, explicit confirmation gate, idempotent confirmation, cancellation, redacted chat IDs, no-store, Origin rejection and metadata-only status. It uses a temporary database and harmless fixture text. It does not connect to real ChatGPT tabs or prove that a human approved the prompt.
