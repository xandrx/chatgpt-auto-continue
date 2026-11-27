use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    FromRow, Sqlite, SqlitePool, Transaction,
};
use std::{path::Path, time::{Duration, SystemTime, UNIX_EPOCH}};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub const LEASE_SECONDS: i64 = 45;
pub const MAX_PROMPT: usize = 20_000;
pub const MAX_RESULT: usize = 40_000;

#[derive(Debug)]
pub enum Error {
    Invalid(&'static str),
    Unauthorized,
    NotFound,
    Conflict(&'static str),
    Database(sqlx::Error),
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self { Self::Database(e) }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}
pub fn digest(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
pub fn same_digest(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
fn validate(value: &str, max: usize, field: &'static str) -> Result<()> {
    if value.trim().is_empty() || value.len() > max { return Err(Error::Invalid(field)); }
    Ok(())
}

#[derive(Clone)]
pub struct Store { pool: SqlitePool }

#[derive(Debug, FromRow)]
struct Session {
    id: String, chat_id: String, alias: String, credential_hash: String,
    export_allowed: bool, enabled: bool, worker: Option<String>, epoch: i64,
    lease_until: i64, seen: i64, status: String,
}

#[derive(Debug, Serialize)]
pub struct SessionView {
    pub id: String, pub chat_id: String, pub alias: String, pub export_allowed: bool,
    pub enabled: bool, pub epoch: i64, pub lease_until: i64, pub seen: i64,
    pub status: String, pub online: bool,
}
impl Session {
    fn view(self, time: i64) -> SessionView {
        let online = self.enabled && self.lease_until > time;
        SessionView { id: self.id, chat_id: self.chat_id, alias: self.alias,
            export_allowed: self.export_allowed, enabled: self.enabled, epoch: self.epoch,
            lease_until: self.lease_until, seen: self.seen,
            status: if online { self.status } else { "offline".into() }, online }
    }
}
#[derive(Serialize)]
pub struct Enrollment { pub session: SessionView, pub credential: String }

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Job {
    pub id: String, pub session_id: String, pub prompt: String, pub state: String,
    pub created: i64, pub updated: i64, pub expires: i64,
    pub worker: Option<String>, pub epoch: Option<i64>, pub result: String,
}
#[derive(Debug, Clone)]
pub struct Client {
    pub session_id: String, pub chat_id: String, pub worker: String, pub epoch: i64,
}
impl Store {
    pub async fn open(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path).create_if_missing(true).foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal).busy_timeout(Duration::from_secs(5));
        let store = Self::connect(options).await?;
        store.recover_after_restart(now()).await?;
        Ok(store)
    }
    async fn connect(options: SqliteConnectOptions) -> Result<Self> {
        // A single connection serializes this small personal service's transactions.
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(options).await?;
        sqlx::raw_sql(include_str!("../schema.sql")).execute(&pool).await?;
        Ok(Self { pool })
    }
    // A restarted process cannot attest to delivery in the previous process.
    // Revoke every old lease; keep queued jobs and block ambiguous in-flight jobs.
    async fn recover_after_restart(&self, time: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE jobs SET state='uncertain',updated=? WHERE state IN ('claimed','submitted')")
            .bind(time).execute(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET state='expired',updated=? WHERE state='queued' AND expires<=?")
            .bind(time).bind(time).execute(&mut *tx).await?;
        sqlx::query("UPDATE sessions SET worker=NULL,lease_until=0,epoch=epoch+1,status='offline'")
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    async fn session(tx: &mut Transaction<'_, Sqlite>, id: &str) -> Result<Session> {
        sqlx::query_as("SELECT * FROM sessions WHERE id=?").bind(id)
            .fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
    }
    async fn authenticate(tx: &mut Transaction<'_, Sqlite>, client: &Client, credential: &str) -> Result<Session> {
        validate(&client.worker, 128, "worker")?;
        let row = Self::session(tx, &client.session_id).await.map_err(|e| match e {
            Error::NotFound => Error::Unauthorized, other => other,
        })?;
        if !row.enabled || row.chat_id != client.chat_id ||
            !same_digest(&row.credential_hash, &digest(credential)) {
            return Err(Error::Unauthorized);
        }
        Ok(row)
    }
    fn require_lease(row: &Session, client: &Client, time: i64) -> Result<()> {
        if row.worker.as_deref() != Some(client.worker.as_str()) ||
            row.epoch != client.epoch || row.lease_until <= time {
            return Err(Error::Conflict("lease invalid"));
        }
        Ok(())
    }
    pub async fn enroll(&self, chat: &str, alias: &str, export: bool, time: i64) -> Result<Enrollment> {
        validate(chat, 256, "chat_id")?;
        validate(alias, 128, "alias")?;
        let id = Uuid::new_v4().to_string();
        let credential = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut tx = self.pool.begin().await?;
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE chat_id=?")
            .bind(chat).fetch_one(&mut *tx).await?;
        if exists != 0 { return Err(Error::Conflict("chat already enrolled")); }
        sqlx::query("INSERT INTO sessions(id,chat_id,alias,credential_hash,export_allowed) VALUES(?,?,?,?,?)")
            .bind(&id).bind(chat).bind(alias).bind(digest(&credential)).bind(export)
            .execute(&mut *tx).await?;
        let session = Self::session(&mut tx, &id).await?.view(time);
        tx.commit().await?;
        Ok(Enrollment { session, credential })
    }
    pub async fn list(&self, time: i64) -> Result<Vec<SessionView>> {
        let rows: Vec<Session> = sqlx::query_as("SELECT * FROM sessions ORDER BY seen DESC,id LIMIT 200")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|s| s.view(time)).collect())
    }
    pub async fn revoke(&self, id: &str, time: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::session(&mut tx, id).await?;
        sqlx::query("UPDATE sessions SET enabled=0,lease_until=0,epoch=epoch+1,status='offline' WHERE id=? AND enabled=1")
            .bind(id).execute(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET state='uncertain',updated=? WHERE session_id=? AND state IN ('claimed','submitted')")
            .bind(time).bind(id).execute(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET state='canceled',updated=? WHERE session_id=? AND state='queued'")
            .bind(time).bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn heartbeat(&self, client: &Client, credential: &str, status: &str, time: i64) -> Result<SessionView> {
        if !matches!(status, "idle" | "busy" | "blocked") { return Err(Error::Invalid("status")); }
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
        sqlx::query("UPDATE sessions SET worker=?,epoch=?,lease_until=?,seen=?,status=? WHERE id=?")
            .bind(&client.worker).bind(epoch).bind(time + LEASE_SECONDS).bind(time).bind(status)
            .bind(&client.session_id).execute(&mut *tx).await?;
        let view = Self::session(&mut tx, &client.session_id).await?.view(time);
        tx.commit().await?;
        Ok(view)
    }
    pub async fn enqueue(&self, id: &str, session_id: &str, prompt: &str, ttl: i64, time: i64) -> Result<Job> {
        validate(id, 128, "request_id")?;
        validate(prompt, MAX_PROMPT, "prompt")?;
        if !(1..=86_400).contains(&ttl) { return Err(Error::Invalid("ttl_seconds")); }
        let mut tx = self.pool.begin().await?;
        let previous: Option<Job> = sqlx::query_as("SELECT * FROM jobs WHERE id=?")
            .bind(id).fetch_optional(&mut *tx).await?;
        if let Some(job) = previous {
            if job.session_id != session_id || job.prompt != prompt || job.expires - job.created != ttl {
                return Err(Error::Conflict("request_id conflict"));
            }
            tx.commit().await?;
            return Ok(job);
        }
        if !Self::session(&mut tx, session_id).await?.enabled { return Err(Error::Conflict("session revoked")); }
        sqlx::query("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES(?,?,?,'queued',?,?,?)")
            .bind(id).bind(session_id).bind(prompt).bind(time).bind(time).bind(time + ttl)
            .execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(job)
    }
    async fn job_tx(tx: &mut Transaction<'_, Sqlite>, id: &str) -> Result<Job> {
        sqlx::query_as("SELECT * FROM jobs WHERE id=?").bind(id)
            .fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)
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
    pub async fn cancel(&self, id: &str, time: i64) -> Result<Job> {
        let mut tx = self.pool.begin().await?;
        let job = Self::job_tx(&mut tx, id).await?;
        if !matches!(job.state.as_str(), "queued" | "canceled") { return Err(Error::Conflict("only queued jobs can be canceled")); }
        sqlx::query("UPDATE jobs SET state='canceled',updated=? WHERE id=? AND state='queued'")
            .bind(time).bind(id).execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(job)
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
        } else { None };
        let job = if let Some(job) = job {
            sqlx::query("UPDATE jobs SET state='claimed',worker=?,epoch=?,updated=? WHERE id=? AND state='queued'")
                .bind(&client.worker).bind(client.epoch).bind(time).bind(&job.id)
                .execute(&mut *tx).await?;
            Some(Self::job_tx(&mut tx, &job.id).await?)
        } else { None };
        tx.commit().await?;
        Ok(job)
    }
    pub async fn ack(&self, client: &Client, credential: &str, id: &str, target: &str, result: &str, time: i64) -> Result<Job> {
        if result.len() > MAX_RESULT { return Err(Error::Invalid("result too long")); }
        let mut tx = self.pool.begin().await?;
        let row = Self::authenticate(&mut tx, client, credential).await?;
        Self::require_lease(&row, client, time)?;
        let job = Self::job_tx(&mut tx, id).await?;
        if job.session_id != client.session_id || job.worker.as_deref() != Some(client.worker.as_str()) || job.epoch != Some(client.epoch) {
            return Err(Error::Unauthorized);
        }
        if !result.is_empty() && (!row.export_allowed || target != "completed") {
            return Err(Error::Conflict("result export not permitted"));
        }
        if job.state == target && matches!(target, "submitted" | "completed" | "failed" | "uncertain") {
            if job.result != result { return Err(Error::Conflict("ack payload conflict")); }
            tx.commit().await?;
            return Ok(job);
        }
        if !matches!((job.state.as_str(), target), ("claimed", "submitted" | "failed" | "uncertain") | ("submitted", "completed" | "uncertain")) {
            return Err(Error::Conflict("invalid state transition"));
        }
        sqlx::query("UPDATE jobs SET state=?,result=?,updated=? WHERE id=?")
            .bind(target).bind(result).bind(time).bind(id).execute(&mut *tx).await?;
        let job = Self::job_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture(export: bool) -> (Store, Enrollment, Client) {
        let store = Store::connect(SqliteConnectOptions::new().in_memory(true).foreign_keys(true)).await.unwrap();
        let enrolled = store.enroll("chat-test", "test", export, 100).await.unwrap();
        let mut client = Client { session_id: enrolled.session.id.clone(), chat_id: "chat-test".into(), worker: "tab-a".into(), epoch: 0 };
        client.epoch = store.heartbeat(&client, &enrolled.credential, "idle", 100).await.unwrap().epoch;
        (store, enrolled, client)
    }
    #[tokio::test]
    async fn idempotency_and_one_claim() {
        let (s, e, c) = fixture(false).await;
        let a = s.enqueue("r1", &c.session_id, "test", 600, 101).await.unwrap();
        let b = s.enqueue("r1", &c.session_id, "test", 600, 102).await.unwrap();
        assert_eq!(a.created,b.created);
        assert!(s.enqueue("r1", &c.session_id, "different", 600, 103).await.is_err());
        s.enqueue("r2", &c.session_id, "test2", 600, 103).await.unwrap();
        let (a,b) = tokio::join!(s.claim(&c,&e.credential,104),s.claim(&c,&e.credential,104));
        assert_eq!((a.unwrap().is_some() as usize) + (b.unwrap().is_some() as usize),1);
        s.ack(&c,&e.credential,"r1","submitted","",105).await.unwrap();
        s.ack(&c,&e.credential,"r1","completed","",106).await.unwrap();
        assert_eq!(s.claim(&c,&e.credential,107).await.unwrap().unwrap().id,"r2");
    }
    #[tokio::test]
    async fn lease_expiration_fences_old_worker_and_blocks_uncertain_job() {
        let (s,e,c) = fixture(false).await;
        s.enqueue("r1",&c.session_id,"test",600,101).await.unwrap();
        s.claim(&c,&e.credential,102).await.unwrap().unwrap();
        let mut other = c.clone(); other.worker = "tab-b".into();
        assert!(s.heartbeat(&other,&e.credential,"idle",103).await.is_err());
        other.epoch = s.heartbeat(&other,&e.credential,"idle",146).await.unwrap().epoch;
        assert!(s.ack(&c,&e.credential,"r1","submitted","",147).await.is_err());
        assert_eq!(s.job("r1",147).await.unwrap().state,"uncertain");
        assert!(s.claim(&other,&e.credential,147).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn authorization_and_export_scope() {
        let (s,e,c) = fixture(false).await;
        let mut wrong = c.clone(); wrong.chat_id = "other-chat".into();
        assert!(matches!(s.claim(&wrong,&e.credential,101).await,Err(Error::Unauthorized)));
        assert!(matches!(s.claim(&c,"invalid",101).await,Err(Error::Unauthorized)));
        s.enqueue("r1",&c.session_id,"test",600,101).await.unwrap();
        s.claim(&c,&e.credential,102).await.unwrap();
        s.ack(&c,&e.credential,"r1","submitted","",103).await.unwrap();
        assert!(s.ack(&c,&e.credential,"r1","completed","sample answer",104).await.is_err());
        s.revoke(&c.session_id,105).await.unwrap();
        assert!(s.heartbeat(&c,&e.credential,"idle",106).await.is_err());
        assert_eq!(s.job("r1",106).await.unwrap().state,"uncertain");
    }
    #[tokio::test]
    async fn disk_restart_preserves_queue_and_invalidates_lease() {
        let directory = std::env::temp_dir().join(format!("csd-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("test.sqlite3");
        let s = Store::open(&path).await.unwrap();
        let t = now();
        let e = s.enroll("chat-restart", "test", false, t).await.unwrap();
        let mut c = Client { session_id:e.session.id.clone(), chat_id:"chat-restart".into(), worker:"tab-a".into(), epoch:0 };
        c.epoch = s.heartbeat(&c, &e.credential, "idle", t).await.unwrap().epoch;
        s.enqueue("first", &c.session_id, "test", 600, t).await.unwrap();
        s.enqueue("second", &c.session_id, "test", 600, t+1).await.unwrap();
        s.claim(&c, &e.credential, t+2).await.unwrap().unwrap();
        s.pool.close().await;
        drop(s);
        let s = Store::open(&path).await.unwrap();
        assert_eq!(s.job("first", now()).await.unwrap().state, "uncertain");
        assert_eq!(s.job("second", now()).await.unwrap().state, "queued");
        assert!(s.ack(&c, &e.credential, "first", "submitted", "", now()).await.is_err());
        assert!(!s.list(now()).await.unwrap()[0].online);
        c.epoch = s.heartbeat(&c, &e.credential, "idle", now()).await.unwrap().epoch;
        assert!(s.claim(&c, &e.credential, now()).await.unwrap().is_none());
        s.pool.close().await;
        drop(s);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn expiry_cancel_and_ack_replay() {
        let (s,e,c) = fixture(true).await;
        s.enqueue("expired",&c.session_id,"test",1,101).await.unwrap();
        assert_eq!(s.job("expired",102).await.unwrap().state,"expired");
        s.enqueue("cancel",&c.session_id,"test",600,102).await.unwrap();
        assert_eq!(s.cancel("cancel",103).await.unwrap().state,"canceled");
        s.enqueue("r1",&c.session_id,"test",600,104).await.unwrap();
        assert_eq!(s.claim(&c,&e.credential,105).await.unwrap().unwrap().id,"r1");
        assert!(s.cancel("r1",106).await.is_err());
        s.ack(&c,&e.credential,"r1","submitted","",106).await.unwrap();
        s.ack(&c,&e.credential,"r1","completed","answer",107).await.unwrap();
        assert_eq!(s.ack(&c,&e.credential,"r1","completed","answer",108).await.unwrap().updated,107);
        assert!(s.ack(&c,&e.credential,"r1","completed","different",109).await.is_err());
    }
}
