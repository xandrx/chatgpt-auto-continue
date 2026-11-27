CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL UNIQUE,
    alias TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    export_allowed INTEGER NOT NULL DEFAULT 0 CHECK(export_allowed IN (0,1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    worker TEXT,
    epoch INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('offline','idle','busy','blocked'))
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    prompt TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','claimed','submitted','completed','failed','canceled','expired','uncertain')),
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    worker TEXT,
    epoch INTEGER,
    result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(session_id,state,created,id);
CREATE UNIQUE INDEX IF NOT EXISTS one_inflight ON jobs(session_id)
WHERE state IN ('claimed','submitted','uncertain');

-- Durable retry orchestration for explicitly confirmed MCP tasks. Each attempt
-- has its own immutable job ID; only expired, never-claimed attempts are retried.
CREATE TABLE IF NOT EXISTS dispatch_tasks (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    prompt TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    retry_delay_seconds INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    current_job_id TEXT NOT NULL,
    next_retry_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','in_progress','completed','failed','uncertain','canceled'))
);
CREATE INDEX IF NOT EXISTS dispatch_tasks_due ON dispatch_tasks(state,next_retry_at);

-- Operator review is distinct from a client acknowledgment.
CREATE TABLE IF NOT EXISTS job_reviews (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed')),
    note TEXT NOT NULL,
    reviewed_at INTEGER NOT NULL
);

-- Two-phase MCP dispatch: a prepared prompt is never queued until confirmed.
CREATE TABLE IF NOT EXISTS mcp_approvals (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    prompt TEXT NOT NULL,
    ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds BETWEEN 1 AND 86400),
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','queued','canceled','expired')),
    job_id TEXT REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS mcp_approvals_expiry ON mcp_approvals(state,expires);
