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
print("SQLite schema: 7 checks passed (unique chat, FK, state, in-flight lock, uncertainty lock, release, export default)")
