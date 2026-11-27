"""Development-only SQLite constraint check; no Python runtime dependency."""
import sqlite3
from pathlib import Path

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript((Path(__file__).resolve().parents[1] / "schema.sql").read_text(encoding="utf-8"))
db.execute("INSERT INTO sessions(id,chat_id,alias,credential_hash) VALUES('s','c','test','fixture')")
def reject(sql):
    try:
        db.execute(sql)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("constraint did not reject invalid data")

reject("INSERT INTO sessions(id,chat_id,alias,credential_hash) VALUES('other','c','test','fixture')")
reject("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES('orphan','missing','test','queued',1,1,2)")
reject("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES('invalid','s','test','invalid',1,1,2)")
db.execute("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES('a','s','test','claimed',1,1,2)")
db.execute("INSERT INTO jobs(id,session_id,prompt,state,created,updated,expires) VALUES('b','s','test','queued',1,1,2)")
reject("UPDATE jobs SET state='claimed' WHERE id='b'")
db.execute("UPDATE jobs SET state='uncertain' WHERE id='a'")
reject("UPDATE jobs SET state='claimed' WHERE id='b'")
db.execute("UPDATE jobs SET state='completed' WHERE id='a'")
db.execute("UPDATE jobs SET state='claimed' WHERE id='b'")
assert db.execute("SELECT export_allowed FROM sessions WHERE id='s'").fetchone() == (0,)
db.execute("INSERT INTO mcp_approvals(id,request_id,session_id,prompt,ttl_seconds,created,expires,state) VALUES('approval','request','s','fixture',60,1,121,'pending')")
reject("INSERT INTO mcp_approvals(id,request_id,session_id,prompt,ttl_seconds,created,expires,state) VALUES('approval2','request','s','fixture',60,1,121,'pending')")
reject("INSERT INTO mcp_approvals(id,request_id,session_id,prompt,ttl_seconds,created,expires,state) VALUES('approval3','request3','s','fixture',0,1,121,'pending')")
reject("INSERT INTO mcp_approvals(id,request_id,session_id,prompt,ttl_seconds,created,expires,state) VALUES('approval4','request4','missing','fixture',60,1,121,'pending')")
db.execute("INSERT INTO dispatch_tasks(request_id,session_id,prompt,attempt,max_attempts,ttl_seconds,retry_delay_seconds,deadline,current_job_id,next_retry_at,state) VALUES('b','s','fixture',1,3,60,30,600,'b',91,'active')")
reject("INSERT INTO dispatch_tasks(request_id,session_id,prompt,attempt,max_attempts,ttl_seconds,retry_delay_seconds,deadline,current_job_id,next_retry_at,state) VALUES('orphan-task','s','fixture',1,3,60,30,600,'b',91,'active')")
reject("UPDATE dispatch_tasks SET state='invalid' WHERE request_id='b'")
print("SQLite schema: 14 checks passed (session/job FKs, retry task ID/state, unique chat, job states, in-flight and uncertainty locks, release, export default, approval constraints)")
