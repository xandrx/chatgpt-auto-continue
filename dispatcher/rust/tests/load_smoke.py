"""Linux release-process load smoke, synthetic tasks only, no external network.

500 enrolled sessions are exercised in bounded batches (not 500 concurrent waits).
The timing and RSS figures are observational, not performance assertions.
"""
import concurrent.futures as cf
import os
from pathlib import Path
import secrets
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
from http_smoke import request


def resources(pid):
    status = Path(f"/proc/{pid}/status").read_text()
    stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    rss_kib = int(next(line for line in status.splitlines() if line.startswith("VmRSS:")).split()[1])
    cpu_seconds = (int(stat[11]) + int(stat[12])) / os.sysconf("SC_CLK_TCK")
    return rss_kib / 1024, cpu_seconds


def run(binary, count, parallel):
    admin = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, DISPATCHER_ADMIN_TOKEN=admin,
                   DISPATCHER_DB=str(Path(tmp) / "load.sqlite3"))
        proc = subprocess.Popen([str(binary)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while True:
                assert proc.poll() is None, "test process exited"
                try:
                    request("GET", "/health")
                    break
                except urllib.error.URLError:
                    assert time.monotonic() < deadline, "startup timeout"
                    time.sleep(0.1)
            rss_idle, cpu_before = resources(proc.pid)
            idle_start = time.monotonic()
            time.sleep(1)
            _, cpu_after = resources(proc.pid)
            idle_cpu = 100 * (cpu_after - cpu_before) / (time.monotonic() - idle_start)

            def enroll(i):
                chat = f"fixture-chat-{i}"
                data = request("POST", "/v1/sessions", admin,
                               {"chat_id": chat, "alias": f"fixture-{i}"})
                return i, data["session"]["id"], data["credential"], chat

            def heartbeat(session):
                i, sid, key, chat = session
                client = {"chat_id": chat, "worker": f"worker-{i}", "epoch": 0}
                lease = request("POST", f"/v1/sessions/{sid}/heartbeat", key, dict(client, status="idle"))
                client["epoch"] = lease["epoch"]
                return session, client

            def wait(item):
                session, client = item
                i, sid, key, _ = session
                job = request("POST", f"/v1/sessions/{sid}/wait", key, dict(client, wait_ms=10000))["job"]
                assert job is not None and job["id"] == f"job-{i}" and job["session_id"] == sid
                return item, job["id"], time.monotonic()

            def enqueue(item):
                (i, sid, _, _), _ = item
                started = time.monotonic()
                request("POST", "/v1/jobs", admin,
                        {"request_id": f"job-{i}", "session_id": sid,
                         "prompt": "synthetic load payload", "ttl_seconds": 120})
                return f"job-{i}", started

            def finish(delivery):
                ((i, sid, key, _), client), job_id, _ = delivery
                prefix = f"/v1/sessions/{sid}"
                request("POST", prefix + "/ack", key, dict(client, request_id=job_id, state="submitted"))
                request("POST", prefix + "/ack", key, dict(client, request_id=job_id, state="completed"))
                assert request("GET", f"/v1/jobs/{job_id}", admin)["state"] == "completed"

            elapsed_ms = []
            peak_sampled_rss = rss_idle
            seen = set()
            with cf.ThreadPoolExecutor(max_workers=parallel) as control, cf.ThreadPoolExecutor(max_workers=parallel) as waiting:
                sessions = list(control.map(enroll, range(count)))
                registered = set()
                cursor = ''
                while True:
                    page = request('GET', '/v1/sessions?limit=100&after=' + cursor, admin)
                    for row in page['sessions']:
                        assert row['id'] not in registered
                        registered.add(row['id'])
                    cursor = page.get('next_after')
                    if cursor is None:
                        break
                assert registered == {session[1] for session in sessions}
                for offset in range(0, count, parallel):
                    batch = list(control.map(heartbeat, sessions[offset:offset + parallel]))
                    futures = [waiting.submit(wait, item) for item in batch]
                    time.sleep(0.15)
                    peak_sampled_rss = max(peak_sampled_rss, resources(proc.pid)[0])
                    starts = dict(control.map(enqueue, batch))
                    deliveries = [f.result(timeout=35) for f in futures]
                    for _, job_id, delivered in deliveries:
                        assert job_id not in seen, "duplicate claim"
                        seen.add(job_id)
                        elapsed_ms.append(1000 * (delivered - starts[job_id]))
                    list(control.map(finish, deliveries))
                    peak_sampled_rss = max(peak_sampled_rss, resources(proc.pid)[0])
            assert len(seen) == count
            p95 = sorted(elapsed_ms)[max(0, (95 * len(elapsed_ms) + 99) // 100 - 1)]
            print(f"LOAD enrolled={count} parallel_cap={parallel} delivered={len(seen)} "
                  f"enqueue_to_claim_p50_ms={statistics.median(elapsed_ms):.2f} p95_ms={p95:.2f} "
                  f"idle_rss_mib={rss_idle:.2f} sampled_rss_mib={peak_sampled_rss:.2f} idle_cpu_pct={idle_cpu:.2f}",
                  flush=True)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    binary = Path(sys.argv[1]).resolve()
    for size in (10, 50, 100, 500):
        run(binary, size, min(100, size))
