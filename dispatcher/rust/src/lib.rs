use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    FromRow, Sqlite, SqlitePool, Transaction,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::{
    sync::{watch, Semaphore},
    time::Instant,
};
use uuid::Uuid;

pub const LEASE_SECONDS: i64 = 45;
pub const MAX_PROMPT: usize = 20_000;
pub const MAX_RESULT: usize = 40_000;
pub const MAX_WAIT_MS: u64 = 25_000;
const MAX_WAITERS: usize = 256;

#[derive(Debug)]
pub enum Error {
    Invalid(&'static str),
    Unauthorized,
    NotFound,
    Conflict(&'static str),
    Database(sqlx::Error),
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Self::Database(e)
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn same_digest(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
fn validate(value: &str, max: usize, field: &'static str) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err(Error::Invalid(field));
    }
    Ok(())
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    changes: Arc<Mutex<HashMap<String, Weak<watch::Sender<u64>>>>>,
    waiters: Arc<Semaphore>,
}

#[derive(Debug, FromRow)]
struct Session {
    id: String,
    chat_id: String,
    alias: String,
    credential_hash: String,
    export_allowed: bool,
    enabled: bool,
    worker: Option<String>,
    epoch: i64,
    lease_until: i64,
    seen: i64,
    status: String,
}

#[derive(Debug, Serialize)]
pub struct SessionView {
    pub id: String,
    pub chat_id: String,
    pub alias: String,
    pub export_allowed: bool,
    pub enabled: bool,
    pub epoch: i64,
    pub lease_until: i64,
    pub seen: i64,
    pub status: String,
    pub online: bool,
}
#[derive(Debug, Serialize)]
pub struct SessionPage {
    pub sessions: Vec<SessionView>,
    pub next_after: Option<String>,
}
impl Session {
    fn view(self, time: i64) -> SessionView {
        let online = self.enabled && self.lease_until > time;
        SessionView {
            id: self.id,
            chat_id: self.chat_id,
            alias: self.alias,
            export_allowed: self.export_allowed,
            enabled: self.enabled,
            epoch: self.epoch,
            lease_until: self.lease_until,
            seen: self.seen,
            status: if online {
                self.status
            } else {
                "offline".into()
            },
            online,
        }
    }
}
#[derive(Serialize)]
pub struct Enrollment {
    pub session: SessionView,
    pub credential: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Job {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub state: String,
    pub created: i64,
    pub updated: i64,
    pub expires: i64,
    pub worker: Option<String>,
    pub epoch: Option<i64>,
    pub result: String,
}
#[derive(Debug, Serialize, FromRow)]
pub struct JobObservation {
    pub id: String,
    pub session_id: String,
    pub state: String,
    pub created: i64,
    pub updated: i64,
    pub expires: i64,
}
#[derive(Debug, Serialize, FromRow)]
pub struct PreparedTask {
    pub id: String,
    pub request_id: String,
    pub session_id: String,
    pub alias: String,
    pub prompt: String,
    pub ttl_seconds: i64,
    pub created: i64,
    pub expires: i64,
    pub state: String,
    pub job_id: Option<String>,
    pub session_status: String,
    pub session_online: bool,
}
#[derive(Debug, Serialize)]
pub struct JobReceipt {
    pub request_id: String,
    pub session_id: String,
    pub state: String,
    pub created: i64,
    pub expires: i64,
}
impl From<Job> for JobReceipt {
    fn from(job: Job) -> Self {
        Self {
            request_id: job.id,
            session_id: job.session_id,
            state: job.state,
            created: job.created,
            expires: job.expires,
        }
    }
}
#[derive(Debug, Serialize, FromRow)]
pub struct Review {
    pub job_id: String,
    pub outcome: String,
    pub note: String,
    pub reviewed_at: i64,
}
#[derive(Debug, Clone)]
pub struct Client {
    pub session_id: String,
    pub chat_id: String,
    pub worker: String,
    pub epoch: i64,
}
impl Store {
    pub async fn open(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let store = Self::connect(options).await?;
        store.recover_after_restart(now()).await?;
        Ok(store)
    }
    async fn connect(options: SqliteConnectOptions) -> Result<Self> {
        // A single connection serializes this small personal service's transactions.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await?;
        Ok(Self {
            pool,
            changes: Arc::new(Mutex::new(HashMap::new())),
            waiters: Arc::new(Semaphore::new(MAX_WAITERS)),
        })
    }
    fn session_signal(&self, id: &str) -> Arc<watch::Sender<u64>> {
        let mut signals = self.changes.lock().unwrap_or_else(|e| e.into_inner());
        // Weak entries do not keep abandoned waiters alive.
        signals.retain(|_, signal| signal.strong_count() > 0);
        if let Some(signal) = signals.get(id).and_then(Weak::upgrade) {
            return signal;
        }
        let (sender, _) = watch::channel(0);
        let signal = Arc::new(sender);
        signals.insert(id.to_owned(), Arc::downgrade(&signal));
        signal
    }
    fn notify_change(&self, id: &str) {
        let signal = {
            let signals = self.changes.lock().unwrap_or_else(|e| e.into_inner());
            signals.get(id).and_then(Weak::upgrade)
        };
        if let Some(signal) = signal {
            signal.send_modify(|revision| *revision = revision.wrapping_add(1));
        }
    }
    // A restarted process cannot attest to delivery in the previous process.
    // Revoke every old lease; keep queued jobs and block ambiguous in-flight jobs.
    async fn recover_after_restart(&self, time: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE jobs SET state='uncertain',updated=? WHERE state IN ('claimed','submitted')",
        )
        .bind(time)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE jobs SET state='expired',updated=? WHERE state='queued' AND expires<=?",
        )
        .bind(time)
        .bind(time)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE sessions SET worker=NULL,lease_until=0,epoch=epoch+1,status='offline'")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    async fn session(tx: &mut Transaction<'_, Sqlite>, id: &str) -> Result<Session> {
        sqlx::query_as("SELECT * FROM sessions WHERE id=?")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(Error::NotFound)
    }
    async fn authenticate(
        tx: &mut Transaction<'_, Sqlite>,
        client: &Client,
        credential: &str,
    ) -> Result<Session> {
        validate(&client.worker, 128, "worker")?;
        let row = Self::session(tx, &client.session_id)
            .await
            .map_err(|e| match e {
                Error::NotFound => Error::Unauthorized,
                other => other,
            })?;
        if !row.enabled
            || row.chat_id != client.chat_id
            || !same_digest(&row.credential_hash, &digest(credential))
        {
            return Err(Error::Unauthorized);
        }
        Ok(row)
    }
    fn require_lease(row: &Session, client: &Client, time: i64) -> Result<()> {
        if row.worker.as_deref() != Some(client.worker.as_str())
            || row.epoch != client.epoch
            || row.lease_until <= time
        {
            return Err(Error::Conflict("lease invalid"));
        }
        Ok(())
    }
    pub async fn enroll(
        &self,
        chat: &str,
        alias: &str,
        export: bool,
        time: i64,
    ) -> Result<Enrollment> {
        validate(chat, 256, "chat_id")?;
        validate(alias, 128, "alias")?;
        let id = Uuid::new_v4().to_string();
        let credential = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut tx = self.pool.begin().await?;
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE chat_id=?")
            .bind(chat)
            .fetch_one(&mut *tx)
            .await?;
        if exists != 0 {
            return Err(Error::Conflict("chat already enrolled"));
        }
        sqlx::query("INSERT INTO sessions(id,chat_id,alias,credential_hash,export_allowed) VALUES(?,?,?,?,?)")
            .bind(&id).bind(chat).bind(alias).bind(digest(&credential)).bind(export)
            .execute(&mut *tx).await?;
        let session = Self::session(&mut tx, &id).await?.view(time);
        tx.commit().await?;
        Ok(Enrollment {
            session,
            credential,
        })
    }
    pub async fn list(&self, time: i64) -> Result<Vec<SessionView>> {
        Ok(self.list_page("", 200, time).await?.sessions)
    }
    pub async fn list_page(&self, after: &str, limit: u32, time: i64) -> Result<SessionPage> {
        if limit == 0 || limit > 200 || after.len() > 128 {
            return Err(Error::Invalid("pagination"));
        }
        // Stable identifier ordering is unaffected by changing heartbeats.
        let mut rows: Vec<Session> =
            sqlx::query_as("SELECT * FROM sessions WHERE id>? ORDER BY id LIMIT ?")
                .bind(after)
                .bind(i64::from(limit) + 1)
                .fetch_all(&self.pool)
                .await?;
        let next_after = if rows.len() > limit as usize {
            rows.pop();
            rows.last().map(|row| row.id.clone())
        } else {
            None
        };
        Ok(SessionPage {
            sessions: rows.into_iter().map(|s| s.view(time)).collect(),
            next_after,
        })
    }
    pub async fn revoke(&self, id: &str, time: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::session(&mut tx, id).await?;
        sqlx::query("UPDATE sessions SET enabled=0,lease_until=0,epoch=epoch+1,status='offline' WHERE id=? AND enabled=1")
            .bind(id).execute(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET state='uncertain',updated=? WHERE session_id=? AND state IN ('claimed','submitted')")
            .bind(time).bind(id).execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE jobs SET state='canceled',updated=? WHERE session_id=? AND state='queued'",
        )
        .bind(time)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.notify_change(id);
        Ok(())
    }
    pub async fn heartbeat(
        &self,
        client: &Client,
        credential: &str,
        status: &str,
        time: i64,
    ) -> Result<SessionView> {
        if !matches!(status, "idle" | "busy" | "blocked") {
            return Err(Error::Invalid("status"));
        }
        let mut tx = self.pool.begin().await?;
        let row = Self::authenticate(&mut tx, client, credential).await?;
        let epoch = if row.lease_until > time {
            Self::require_lease(&row, client, time)?;
            row.epoch
        } else {
            // We cannot know whether an earlier click reached ChatGPT.
            sqlx::query("UPDATE jobs SET state='uncertain',updated=? WHERE session_id=? AND state IN ('claimed','submitted')")
                .bind(time).bind(&client.session_id).execute(&mut *tx).await?;
            row.epoch + 1
        };
        sqlx::query(
            "UPDATE sessions SET worker=?,epoch=?,lease_until=?,seen=?,status=? WHERE id=?",
        )
        .bind(&client.worker)
        .bind(epoch)
        .bind(time + LEASE_SECONDS)
        .bind(time)
        .bind(status)
        .bind(&client.session_id)
        .execute(&mut *tx)
        .await?;
        let view = Self::session(&mut tx, &client.session_id).await?.view(time);
        tx.commit().await?;
        if row.status != status || row.epoch != epoch {
            self.notify_change(&client.session_id);
        }
        Ok(view)
    }
    pub async fn enqueue(
        &self,
        id: &str,
        session_id: &str,
        prompt: &str,
        ttl: i64,
        time: i64,
    ) -> Result<Job> {
        validate(id, 128, "request_id")?;
        validate(prompt, MAX_PROMPT, "prompt")?;
        if !(1..=86_400).contains(&ttl) {
            return Err(Error::Invalid("ttl_seconds"));
        }
        let mut tx = self.pool.begin().await?;
        let previous: Option<Job> = sqlx::query_as("SELECT * FROM jobs WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(job) = previous {
            if job.session_id != session_id
                || job.prompt != prompt
                || job.expires - job.created != ttl
            {
                return Err(Error::Conflict("request_id conflict"));
            }
            tx.commit().await?;
            return Ok(job);
        }
        if !Self::session(&mut tx, session_id).await?.enabled {
            return Err(Error::Conflict("session revoked"));
        }
        sqlx::query("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES(?,?,?,'queued',?,?,?)")
            .bind(id).bind(session_id).bind(prompt).bind(time).bind(time).bind(time + ttl)
            .execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        self.notify_change(session_id);
        Ok(job)
    }
    async fn job_tx(tx: &mut Transaction<'_, Sqlite>, id: &str) -> Result<Job> {
        sqlx::query_as("SELECT * FROM jobs WHERE id=?")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(Error::NotFound)
    }
    pub async fn job(&self, id: &str, time: i64) -> Result<Job> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE jobs SET state='expired',updated=? WHERE id=? AND state='queued' AND expires<=?")
            .bind(time).bind(id).bind(time).execute(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET state='uncertain',updated=? WHERE id=? AND state IN ('claimed','submitted') AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=jobs.session_id AND s.enabled=1 AND s.epoch=jobs.epoch AND s.lease_until>?)")
            .bind(time).bind(id).bind(time).execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(job)
    }
    /// Read-only projection for the separate observation scope.
    pub async fn observe_job(&self, id: &str, time: i64) -> Result<JobObservation> {
        validate(id, 128, "request_id")?;
        sqlx::query_as("SELECT j.id,j.session_id,CASE WHEN j.state='queued' AND j.expires<=? THEN 'expired' WHEN j.state IN ('claimed','submitted') AND (s.enabled=0 OR s.epoch<>j.epoch OR s.lease_until<=?) THEN 'uncertain' ELSE j.state END AS state,j.created,j.updated,j.expires FROM jobs j JOIN sessions s ON s.id=j.session_id WHERE j.id=?")
            .bind(time).bind(time).bind(id).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    /// Persist a proposed MCP task without making it visible to the worker queue.
    /// A pending approval is short-lived and unique per session.
    pub async fn prepare_task(
        &self,
        session_id: &str,
        prompt: &str,
        ttl: i64,
        time: i64,
    ) -> Result<PreparedTask> {
        validate(session_id, 128, "session_id")?;
        validate(prompt, MAX_PROMPT, "prompt")?;
        if !(1..=86_400).contains(&ttl) {
            return Err(Error::Invalid("ttl_seconds"));
        }
        let id = Uuid::new_v4().to_string();
        let request_id = Uuid::new_v4().to_string();
        let mut tx = self.pool.begin().await?;
        let session = Self::session(&mut tx, session_id).await?;
        if !session.enabled {
            return Err(Error::Conflict("session revoked"));
        }
        let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mcp_approvals WHERE session_id=? AND state='pending' AND expires>?")
            .bind(session_id).bind(time).fetch_one(&mut *tx).await?;
        let queued: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM jobs WHERE session_id=? AND state='queued' AND expires>?",
        )
        .bind(session_id)
        .bind(time)
        .fetch_one(&mut *tx)
        .await?;
        let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE session_id=? AND state IN ('claimed','submitted','uncertain')")
            .bind(session_id).fetch_one(&mut *tx).await?;
        if pending > 0 || queued > 0 || active > 0 {
            return Err(Error::Conflict(
                "session already has a pending or unresolved task",
            ));
        }
        sqlx::query("UPDATE mcp_approvals SET state='expired',prompt='' WHERE state='pending' AND expires<=?")
            .bind(time).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO mcp_approvals(id,request_id,session_id,prompt,ttl_seconds,created,expires,state) VALUES(?,?,?,?,?,?,?,'pending')")
            .bind(&id).bind(&request_id).bind(session_id).bind(prompt).bind(ttl).bind(time).bind(time+120)
            .execute(&mut *tx).await?;
        let task = sqlx::query_as::<_, PreparedTask>("SELECT a.id,a.request_id,a.session_id,s.alias,a.prompt,a.ttl_seconds,a.created,a.expires,a.state,a.job_id,s.status AS session_status,(s.enabled=1 AND s.lease_until>?) AS session_online FROM mcp_approvals a JOIN sessions s ON s.id=a.session_id WHERE a.id=?")
            .bind(time).bind(&id).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(task)
    }
    /// Commit a prepared task exactly once. The approval and queue insertion
    /// share one SQLite transaction so a lost MCP response is safely retryable.
    pub async fn confirm_task(&self, approval_id: &str, time: i64) -> Result<JobReceipt> {
        validate(approval_id, 64, "approval_id")?;
        let mut tx = self.pool.begin().await?;
        let row: Option<PreparedTask> = sqlx::query_as("SELECT a.id,a.request_id,a.session_id,s.alias,a.prompt,a.ttl_seconds,a.created,a.expires,a.state,a.job_id,s.status AS session_status,(s.enabled=1 AND s.lease_until>?) AS session_online FROM mcp_approvals a JOIN sessions s ON s.id=a.session_id WHERE a.id=?")
            .bind(time).bind(approval_id).fetch_optional(&mut *tx).await?;
        let row = row.ok_or(Error::NotFound)?;
        if row.state == "queued" {
            let job_id = row
                .job_id
                .as_deref()
                .ok_or(Error::Conflict("approval receipt missing"))?;
            let job = Self::job_tx(&mut tx, job_id).await?;
            tx.commit().await?;
            return Ok(job.into());
        }
        if row.state != "pending" {
            return Err(Error::Conflict("approval is no longer pending"));
        }
        if row.expires <= time {
            sqlx::query(
                "UPDATE mcp_approvals SET state='expired',prompt='' WHERE id=? AND state='pending'",
            )
            .bind(approval_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Err(Error::Conflict("approval expired; prepare again"));
        }
        let session = Self::session(&mut tx, &row.session_id).await?;
        if !session.enabled {
            return Err(Error::Conflict("session revoked"));
        }
        let blocked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE session_id=? AND (state IN ('claimed','submitted','uncertain') OR (state='queued' AND expires>?))")
            .bind(&row.session_id).bind(time).fetch_one(&mut *tx).await?;
        if blocked > 0 {
            return Err(Error::Conflict(
                "session already has a pending or unresolved task",
            ));
        }
        sqlx::query("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES(?,?,?,'queued',?,?,?)")
            .bind(&row.request_id).bind(&row.session_id).bind(&row.prompt).bind(time).bind(time).bind(time+row.ttl_seconds)
            .execute(&mut *tx).await?;
        sqlx::query("UPDATE mcp_approvals SET state='queued',job_id=?,prompt='' WHERE id=? AND state='pending'")
            .bind(&row.request_id).bind(approval_id).execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, &row.request_id).await?;
        tx.commit().await?;
        self.notify_change(&row.session_id);
        Ok(job.into())
    }
    pub async fn cancel_prepared_task(&self, approval_id: &str) -> Result<String> {
        validate(approval_id, 64, "approval_id")?;
        let mut tx = self.pool.begin().await?;
        let state: Option<String> =
            sqlx::query_scalar("SELECT state FROM mcp_approvals WHERE id=?")
                .bind(approval_id)
                .fetch_optional(&mut *tx)
                .await?;
        let final_state = match state.as_deref() {
            Some("pending") => {
                sqlx::query("UPDATE mcp_approvals SET state='canceled',prompt='' WHERE id=? AND state='pending'")
                    .bind(approval_id).execute(&mut *tx).await?;
                "canceled"
            }
            Some("canceled") => "canceled",
            Some("expired") => "expired",
            Some("queued") => {
                return Err(Error::Conflict(
                    "task already queued; cancel the queued job instead",
                ))
            }
            _ => return Err(Error::NotFound),
        };
        tx.commit().await?;
        Ok(final_state.to_owned())
    }
    pub async fn cancel(&self, id: &str, time: i64) -> Result<Job> {
        let mut tx = self.pool.begin().await?;
        let job = Self::job_tx(&mut tx, id).await?;
        if !matches!(job.state.as_str(), "queued" | "canceled") {
            return Err(Error::Conflict("only queued jobs can be canceled"));
        }
        sqlx::query("UPDATE jobs SET state='canceled',updated=? WHERE id=? AND state='queued'")
            .bind(time)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(job)
    }
    /// Resolve ambiguity only after the old lease expires and the operator
    /// explicitly verifies the outcome. This never requeues the original job.
    pub async fn resolve(&self, id: &str, outcome: &str, note: &str, time: i64) -> Result<Job> {
        validate(note, 2000, "review note")?;
        if !matches!(outcome, "completed" | "failed") {
            return Err(Error::Invalid("review outcome"));
        }
        let mut tx = self.pool.begin().await?;
        let job = Self::job_tx(&mut tx, id).await?;
        let prior: Option<(String, String)> =
            sqlx::query_as("SELECT outcome,note FROM job_reviews WHERE job_id=?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some((old_outcome, old_note)) = prior {
            if old_outcome != outcome || old_note != note {
                return Err(Error::Conflict("review already recorded"));
            }
            tx.commit().await?;
            return Ok(job);
        }
        let session = Self::session(&mut tx, &job.session_id).await?;
        if session.lease_until > time {
            return Err(Error::Conflict(
                "stop the worker and wait for lease expiration before review",
            ));
        }
        if !matches!(job.state.as_str(), "uncertain" | "claimed" | "submitted") {
            return Err(Error::Conflict("only ambiguous jobs can be reviewed"));
        }
        sqlx::query("INSERT INTO job_reviews(job_id,outcome,note,reviewed_at) VALUES(?,?,?,?)")
            .bind(id)
            .bind(outcome)
            .bind(note)
            .bind(time)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE jobs SET state=?,updated=? WHERE id=?")
            .bind(outcome)
            .bind(time)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE sessions SET worker=NULL,epoch=epoch+1,lease_until=0,status='offline' WHERE id=?")
            .bind(&job.session_id).execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        self.notify_change(&job.session_id);
        Ok(job)
    }
    pub async fn review(&self, id: &str) -> Result<Option<Review>> {
        Ok(
            sqlx::query_as(
                "SELECT job_id,outcome,note,reviewed_at FROM job_reviews WHERE job_id=?",
            )
            .bind(id)
            .fetch_optional(&self.pool)
            .await?,
        )
    }
    pub async fn claim(&self, client: &Client, credential: &str, time: i64) -> Result<Option<Job>> {
        let mut tx = self.pool.begin().await?;
        let row = Self::authenticate(&mut tx, client, credential).await?;
        Self::require_lease(&row, client, time)?;
        sqlx::query("UPDATE jobs SET state='expired',updated=? WHERE session_id=? AND state='queued' AND expires<=?")
            .bind(time).bind(&client.session_id).bind(time).execute(&mut *tx).await?;
        let job: Option<Job> = if row.status == "idle" {
            sqlx::query_as("SELECT * FROM jobs WHERE session_id=? AND state='queued' AND NOT EXISTS (SELECT 1 FROM jobs AS active WHERE active.session_id=jobs.session_id AND active.state IN ('claimed','submitted','uncertain')) ORDER BY created,id LIMIT 1")
                .bind(&client.session_id).fetch_optional(&mut *tx).await?
        } else {
            None
        };
        let job = if let Some(job) = job {
            sqlx::query("UPDATE jobs SET state='claimed',worker=?,epoch=?,updated=? WHERE id=? AND state='queued'")
                .bind(&client.worker).bind(client.epoch).bind(time).bind(&job.id)
                .execute(&mut *tx).await?;
            Some(Self::job_tx(&mut tx, &job.id).await?)
        } else {
            None
        };
        tx.commit().await?;
        Ok(job)
    }
    pub async fn claim_wait(
        &self,
        client: &Client,
        credential: &str,
        wait_ms: u64,
    ) -> Result<Option<Job>> {
        if wait_ms > MAX_WAIT_MS {
            return Err(Error::Invalid("wait_ms"));
        }
        let _permit = self
            .waiters
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("too many waiters"))?;
        // Subscribe BEFORE checking the queue, avoiding lost notifications.
        let signal = self.session_signal(&client.session_id);
        let mut changes = signal.subscribe();
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        loop {
            // The transaction is committed by claim before awaiting any event.
            // Every wake-up, including timeout, revalidates credentials and lease.
            changes.borrow_and_update();
            if let Some(job) = self.claim(client, credential, now()).await? {
                return Ok(Some(job));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            if tokio::time::timeout_at(deadline, changes.changed())
                .await
                .is_err()
            {
                return self.claim(client, credential, now()).await;
            }
        }
    }
    pub async fn ack(
        &self,
        client: &Client,
        credential: &str,
        id: &str,
        target: &str,
        result: &str,
        time: i64,
    ) -> Result<Job> {
        if result.len() > MAX_RESULT {
            return Err(Error::Invalid("result too long"));
        }
        let mut tx = self.pool.begin().await?;
        let row = Self::authenticate(&mut tx, client, credential).await?;
        Self::require_lease(&row, client, time)?;
        let job = Self::job_tx(&mut tx, id).await?;
        if job.session_id != client.session_id
            || job.worker.as_deref() != Some(client.worker.as_str())
            || job.epoch != Some(client.epoch)
        {
            return Err(Error::Unauthorized);
        }
        if !result.is_empty() && (!row.export_allowed || target != "completed") {
            return Err(Error::Conflict("result export not permitted"));
        }
        if job.state == target
            && matches!(target, "submitted" | "completed" | "failed" | "uncertain")
        {
            if job.result != result {
                return Err(Error::Conflict("ack payload conflict"));
            }
            tx.commit().await?;
            return Ok(job);
        }
        if !matches!(
            (job.state.as_str(), target),
            ("claimed", "submitted" | "failed" | "uncertain")
                | ("submitted", "completed" | "uncertain")
        ) {
            return Err(Error::Conflict("invalid state transition"));
        }
        sqlx::query("UPDATE jobs SET state=?,result=?,updated=? WHERE id=?")
            .bind(target)
            .bind(result)
            .bind(time)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        self.notify_change(&client.session_id);
        Ok(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture(export: bool) -> (Store, Enrollment, Client) {
        let store = Store::connect(
            SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
        let enrolled = store
            .enroll("chat-test", "test", export, 100)
            .await
            .unwrap();
        let mut client = Client {
            session_id: enrolled.session.id.clone(),
            chat_id: "chat-test".into(),
            worker: "tab-a".into(),
            epoch: 0,
        };
        client.epoch = store
            .heartbeat(&client, &enrolled.credential, "idle", 100)
            .await
            .unwrap()
            .epoch;
        (store, enrolled, client)
    }
    #[tokio::test]
    async fn idempotency_and_one_claim() {
        let (s, e, c) = fixture(false).await;
        let a = s
            .enqueue("r1", &c.session_id, "test", 600, 101)
            .await
            .unwrap();
        let b = s
            .enqueue("r1", &c.session_id, "test", 600, 102)
            .await
            .unwrap();
        assert_eq!(a.created, b.created);
        assert!(s
            .enqueue("r1", &c.session_id, "different", 600, 103)
            .await
            .is_err());
        s.enqueue("r2", &c.session_id, "test2", 600, 103)
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            s.claim(&c, &e.credential, 104),
            s.claim(&c, &e.credential, 104)
        );
        assert_eq!(
            (a.unwrap().is_some() as usize) + (b.unwrap().is_some() as usize),
            1
        );
        s.ack(&c, &e.credential, "r1", "submitted", "", 105)
            .await
            .unwrap();
        s.ack(&c, &e.credential, "r1", "completed", "", 106)
            .await
            .unwrap();
        assert_eq!(
            s.claim(&c, &e.credential, 107).await.unwrap().unwrap().id,
            "r2"
        );
    }
    #[tokio::test]
    async fn lease_expiration_fences_old_worker_and_blocks_uncertain_job() {
        let (s, e, c) = fixture(false).await;
        s.enqueue("r1", &c.session_id, "test", 600, 101)
            .await
            .unwrap();
        s.claim(&c, &e.credential, 102).await.unwrap().unwrap();
        let mut other = c.clone();
        other.worker = "tab-b".into();
        assert!(s
            .heartbeat(&other, &e.credential, "idle", 103)
            .await
            .is_err());
        other.epoch = s
            .heartbeat(&other, &e.credential, "idle", 146)
            .await
            .unwrap()
            .epoch;
        assert!(s
            .ack(&c, &e.credential, "r1", "submitted", "", 147)
            .await
            .is_err());
        assert_eq!(s.job("r1", 147).await.unwrap().state, "uncertain");
        assert!(s.claim(&other, &e.credential, 147).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn authorization_and_export_scope() {
        let (s, e, c) = fixture(false).await;
        let mut wrong = c.clone();
        wrong.chat_id = "other-chat".into();
        assert!(matches!(
            s.claim(&wrong, &e.credential, 101).await,
            Err(Error::Unauthorized)
        ));
        assert!(matches!(
            s.claim(&c, "invalid", 101).await,
            Err(Error::Unauthorized)
        ));
        s.enqueue("r1", &c.session_id, "test", 600, 101)
            .await
            .unwrap();
        s.claim(&c, &e.credential, 102).await.unwrap();
        s.ack(&c, &e.credential, "r1", "submitted", "", 103)
            .await
            .unwrap();
        assert!(s
            .ack(&c, &e.credential, "r1", "completed", "sample answer", 104)
            .await
            .is_err());
        s.revoke(&c.session_id, 105).await.unwrap();
        assert!(s.heartbeat(&c, &e.credential, "idle", 106).await.is_err());
        assert_eq!(s.job("r1", 106).await.unwrap().state, "uncertain");
    }
    async fn live_fixture() -> (Store, Enrollment, Client) {
        let s = Store::connect(
            SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
        let e = s.enroll("chat-wait", "test", false, now()).await.unwrap();
        let mut c = Client {
            session_id: e.session.id.clone(),
            chat_id: "chat-wait".into(),
            worker: "tab-a".into(),
            epoch: 0,
        };
        c.epoch = s
            .heartbeat(&c, &e.credential, "idle", now())
            .await
            .unwrap()
            .epoch;
        (s, e, c)
    }
    #[tokio::test]
    async fn wait_wakes_on_enqueue_without_holding_database() {
        let (s, e, c) = live_fixture().await;
        let producer = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            s.enqueue("r1", &c.session_id, "test", 600, now())
                .await
                .unwrap();
        };
        let (job, ()) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(s.claim_wait(&c, &e.credential, 2500), producer)
        })
        .await
        .unwrap();
        assert_eq!(job.unwrap().unwrap().id, "r1");
        assert!(s.claim_wait(&c, &e.credential, 0).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn wait_timeout_and_revocation() {
        let (s, e, c) = live_fixture().await;
        assert!(s.claim_wait(&c, &e.credential, 20).await.unwrap().is_none());
        assert!(matches!(
            s.claim_wait(&c, &e.credential, MAX_WAIT_MS + 1).await,
            Err(Error::Invalid(_))
        ));
        let revoke = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            s.revoke(&c.session_id, now()).await.unwrap();
        };
        let (job, ()) = tokio::join!(s.claim_wait(&c, &e.credential, 1000), revoke);
        assert!(matches!(job, Err(Error::Unauthorized)));
    }
    #[tokio::test]
    async fn wait_wakes_when_session_becomes_idle() {
        let (s, e, c) = live_fixture().await;
        s.heartbeat(&c, &e.credential, "busy", now()).await.unwrap();
        s.enqueue("r1", &c.session_id, "test", 600, now())
            .await
            .unwrap();
        let idle = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            s.heartbeat(&c, &e.credential, "idle", now()).await.unwrap();
        };
        let (job, ()) = tokio::join!(s.claim_wait(&c, &e.credential, 1000), idle);
        assert_eq!(job.unwrap().unwrap().id, "r1");
    }
    #[tokio::test]
    async fn notifications_are_targeted_and_abandoned_signals_do_not_accumulate() {
        let (s, _, c) = fixture(false).await;
        let a = s.session_signal(&c.session_id);
        let b = s.session_signal("other");
        let a_rx = a.subscribe();
        let b_rx = b.subscribe();
        s.enqueue("r1", &c.session_id, "test", 600, 101)
            .await
            .unwrap();
        assert!(a_rx.has_changed().unwrap());
        assert!(!b_rx.has_changed().unwrap());
        drop(b_rx);
        drop(b);
        let _next = s.session_signal("next");
        assert!(!s.changes.lock().unwrap().contains_key("other"));
    }
    #[tokio::test]
    async fn registry_cursor_is_stable_and_complete() {
        let (s, e, c) = fixture(false).await;
        s.enroll("chat2", "test2", false, 100).await.unwrap();
        s.enroll("chat3", "test3", false, 100).await.unwrap();
        let first = s.list_page("", 1, 100).await.unwrap();
        let cursor = first.next_after.unwrap();
        assert_eq!(first.sessions[0].id, cursor);
        s.heartbeat(&c, &e.credential, "busy", 101).await.unwrap();
        let second = s.list_page(&cursor, 2, 101).await.unwrap();
        assert_eq!(second.sessions.len(), 2);
        assert!(second
            .sessions
            .iter()
            .all(|row| row.id.as_str() > cursor.as_str()));
        assert!(second.next_after.is_none());
        assert!(s.list_page("", 0, 101).await.is_err());
    }
    #[tokio::test]
    async fn mcp_prepare_does_not_queue_until_confirm_and_confirm_is_idempotent() {
        let (s, _, c) = fixture(false).await;
        let prepared = s
            .prepare_task(&c.session_id, "deploy only after approval", 600, 101)
            .await
            .unwrap();
        assert_eq!(prepared.state, "pending");
        assert!(prepared.session_online);
        assert_eq!(prepared.session_status, "idle");
        assert_eq!(prepared.prompt, "deploy only after approval");
        assert!(matches!(
            s.job(&prepared.request_id, 102).await,
            Err(Error::NotFound)
        ));
        assert!(s
            .prepare_task(&c.session_id, "second task", 600, 102)
            .await
            .is_err());
        let first = s.confirm_task(&prepared.id, 103).await.unwrap();
        let retry = s.confirm_task(&prepared.id, 104).await.unwrap();
        assert_eq!(first.request_id, prepared.request_id);
        assert_eq!(retry.request_id, first.request_id);
        assert_eq!(retry.created, first.created);
        assert_eq!(retry.state, "queued");
        assert_eq!(
            s.job(&first.request_id, 104).await.unwrap().prompt,
            "deploy only after approval"
        );
        assert!(s
            .prepare_task(&c.session_id, "third task", 600, 105)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn mcp_approval_cancel_expiry_and_revocation_are_safe() {
        let (s, _, c) = fixture(false).await;
        let canceled = s
            .prepare_task(&c.session_id, "cancel me", 600, 100)
            .await
            .unwrap();
        assert_eq!(
            s.cancel_prepared_task(&canceled.id).await.unwrap(),
            "canceled"
        );
        assert_eq!(
            s.cancel_prepared_task(&canceled.id).await.unwrap(),
            "canceled"
        );
        assert!(s.confirm_task(&canceled.id, 101).await.is_err());
        let stored: String = sqlx::query_scalar("SELECT prompt FROM mcp_approvals WHERE id=?")
            .bind(&canceled.id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert!(stored.is_empty());

        let expired = s
            .prepare_task(&c.session_id, "expire me", 600, 200)
            .await
            .unwrap();
        assert!(s.confirm_task(&expired.id, 321).await.is_err());
        let state: String = sqlx::query_scalar("SELECT state FROM mcp_approvals WHERE id=?")
            .bind(&expired.id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(state, "expired");
        assert_eq!(
            s.cancel_prepared_task(&expired.id).await.unwrap(),
            "expired"
        );

        let revoked = s
            .prepare_task(&c.session_id, "do not send", 600, 400)
            .await
            .unwrap();
        s.revoke(&c.session_id, 401).await.unwrap();
        assert!(s.confirm_task(&revoked.id, 402).await.is_err());
        s.cancel_prepared_task(&revoked.id).await.unwrap();
    }
    #[tokio::test]
    async fn observer_reads_only_metadata_without_updating_durable_state() {
        let (s, _, c) = fixture(false).await;
        s.enqueue("r1", &c.session_id, "private fixture", 1, 101)
            .await
            .unwrap();
        let status = s.observe_job("r1", 103).await.unwrap();
        assert_eq!(status.state, "expired");
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("private fixture"));
        let mut tx = s.pool.begin().await.unwrap();
        assert_eq!(Store::job_tx(&mut tx, "r1").await.unwrap().state, "queued");
        tx.commit().await.unwrap();
    }
    #[tokio::test]
    async fn operator_review_requires_expired_lease_and_never_requeues() {
        let (s, e, mut c) = fixture(false).await;
        s.enqueue("r1", &c.session_id, "test", 600, 101)
            .await
            .unwrap();
        s.enqueue("r2", &c.session_id, "next", 600, 102)
            .await
            .unwrap();
        s.claim(&c, &e.credential, 103).await.unwrap().unwrap();
        assert!(s.resolve("r1", "failed", "verified", 104).await.is_err());
        assert!(s.resolve("r1", "queued", "verified", 146).await.is_err());
        assert!(s.resolve("r1", "failed", "", 146).await.is_err());
        assert_eq!(
            s.resolve("r1", "failed", "verified not submitted", 146)
                .await
                .unwrap()
                .state,
            "failed"
        );
        let review = s.review("r1").await.unwrap().unwrap();
        assert_eq!(review.reviewed_at, 146);
        assert_eq!(
            s.resolve("r1", "failed", "verified not submitted", 147)
                .await
                .unwrap()
                .updated,
            146
        );
        assert!(s
            .resolve("r1", "completed", "different", 148)
            .await
            .is_err());
        assert!(s
            .ack(&c, &e.credential, "r1", "submitted", "", 148)
            .await
            .is_err());
        c.epoch = s
            .heartbeat(&c, &e.credential, "idle", 149)
            .await
            .unwrap()
            .epoch;
        assert_eq!(
            s.claim(&c, &e.credential, 150).await.unwrap().unwrap().id,
            "r2"
        );
    }
    #[tokio::test]
    async fn disk_restart_preserves_queue_and_invalidates_lease() {
        let directory = std::env::temp_dir().join(format!("csd-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("test.sqlite3");
        let s = Store::open(&path).await.unwrap();
        let t = now();
        let e = s.enroll("chat-restart", "test", false, t).await.unwrap();
        let mut c = Client {
            session_id: e.session.id.clone(),
            chat_id: "chat-restart".into(),
            worker: "tab-a".into(),
            epoch: 0,
        };
        c.epoch = s
            .heartbeat(&c, &e.credential, "idle", t)
            .await
            .unwrap()
            .epoch;
        s.enqueue("first", &c.session_id, "test", 600, t)
            .await
            .unwrap();
        s.enqueue("second", &c.session_id, "test", 600, t + 1)
            .await
            .unwrap();
        s.claim(&c, &e.credential, t + 2).await.unwrap().unwrap();
        s.pool.close().await;
        drop(s);
        let s = Store::open(&path).await.unwrap();
        assert_eq!(s.job("first", now()).await.unwrap().state, "uncertain");
        assert_eq!(s.job("second", now()).await.unwrap().state, "queued");
        assert!(s
            .ack(&c, &e.credential, "first", "submitted", "", now())
            .await
            .is_err());
        assert!(!s.list(now()).await.unwrap()[0].online);
        c.epoch = s
            .heartbeat(&c, &e.credential, "idle", now())
            .await
            .unwrap()
            .epoch;
        assert!(s.claim(&c, &e.credential, now()).await.unwrap().is_none());
        s.pool.close().await;
        drop(s);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn expiry_cancel_and_ack_replay() {
        let (s, e, c) = fixture(true).await;
        s.enqueue("expired", &c.session_id, "test", 1, 101)
            .await
            .unwrap();
        assert_eq!(s.job("expired", 102).await.unwrap().state, "expired");
        s.enqueue("cancel", &c.session_id, "test", 600, 102)
            .await
            .unwrap();
        assert_eq!(s.cancel("cancel", 103).await.unwrap().state, "canceled");
        s.enqueue("r1", &c.session_id, "test", 600, 104)
            .await
            .unwrap();
        assert_eq!(
            s.claim(&c, &e.credential, 105).await.unwrap().unwrap().id,
            "r1"
        );
        assert!(s.cancel("r1", 106).await.is_err());
        s.ack(&c, &e.credential, "r1", "submitted", "", 106)
            .await
            .unwrap();
        s.ack(&c, &e.credential, "r1", "completed", "answer", 107)
            .await
            .unwrap();
        assert_eq!(
            s.ack(&c, &e.credential, "r1", "completed", "answer", 108)
                .await
                .unwrap()
                .updated,
            107
        );
        assert!(s
            .ack(&c, &e.credential, "r1", "completed", "different", 109)
            .await
            .is_err());
    }
}
