# Dispatcher protocol v1 — development
Transport: loopback HTTP only in the current implementation. No production or real browser connection. This document is the contract for a synthetic test client.

## Session credentials and lifecycle
Operator enrolls an exact chat ID with explicit result-export choice. The enrollment response contains the one-time session credential, session ID and epoch. Operator and session credentials are distinct. Store credentials outside page content. Never print them or include them in URLs. An enrolled session cannot be rebound to a different chat.

A client uses a fresh worker ID for each process/tab instance. It first sends POST /v1/sessions/{id}/heartbeat with chat_id, worker, epoch=0 and status (idle/busy/blocked). On success store the returned epoch and lease_until. Thereafter heartbeat every 15s with the current epoch. Lease duration is 45s. A competing worker receives conflict until the lease expires. Revocation and server restart invalidate leases.

## Long polling
POST /v1/sessions/{id}/wait with chat_id, worker, epoch and wait_ms (0..25000). Authorization: Bearer session credential. Response: {"job":null} or {"job":{...}}. One pending wait per client is recommended. The server caps outstanding waits at 256, releases the database transaction before sleeping, and rechecks authentication/lease on wake or timeout. Enqueue, relevant heartbeat changes, acknowledgements and revoke notify waiters. Notifications are currently global and coalesced; they are hints, not durable messages. A client should use a 35s HTTP timeout and renew its heartbeat independently. Network and DB latency can extend wall-clock response time beyond wait_ms.

A returned job is already claimed; never treat a failed network response as evidence that nothing was claimed. On loss of claim response or delivery acknowledgment, stop and surface uncertainty. Do not retry sending the task. Reconnect with jittered exponential backoff (1–30 seconds) for read/heartbeat failures. An identical acknowledgment for the same job/state/result is idempotent while the same lease remains valid. On 401 or 409 stop processing and request operator attention; do not automatically replace a worker that may still be running. The server never executes prompts or interprets answers as commands.

## Job transitions
queued -> claimed -> submitted -> completed
queued -> canceled or expired
claimed -> failed (known not submitted) or uncertain
submitted -> uncertain
uncertain blocks future claims. POST /v1/jobs/{id}/review is operator-only and accepts outcome (completed or failed), note, verified=true. Stop the old worker, inspect the real conversation, and wait for lease expiration before review. A review records an operator assertion separately from client acknowledgments and never requeues the original task. GET /v1/jobs/{id}/review returns the audit record. Identical review retries are idempotent; conflicting reviews are rejected. Only queued jobs have TTL expiry. Results are optional and accepted only for completed jobs with export enabled. A completion report is a client assertion, not proof of external execution.

## Test scope
Use synthetic sessions and harmless fixture tasks. Do not connect live browser tabs or expose the service until the release gates in DISPATCHER-PLAN.md are satisfied. Browser timing, lease loss while a real DOM operation is pending, and end-to-end delivery remain untested.
