"""Synthetic loopback integration test. Never connects to ChatGPT or a live VPS."""
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8766"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(method, path, credential=None, payload=None, expected=200):
    headers = {}
    if credential:
        headers["Authorization"] = "Bearer " + credential
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        response = OPENER.open(req, timeout=35)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        assert response.status == expected, (method, path, response.status, expected)
        assert response.headers.get("Cache-Control") == "no-store"
        return json.load(response)


def run(binary):
    admin = secrets.token_urlsafe(32)
    enrollment = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, DISPATCHER_ADMIN_TOKEN=admin,
                   DISPATCHER_ENROLL_TOKEN=enrollment,
                   DISPATCHER_DB=str(Path(tmp) / "smoke.sqlite3"))
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
            client_enrolled = request("POST", "/v1/client/enroll", enrollment,
                                      {"chat_id": "client-synthetic-chat", "alias": "client fixture"})
            assert request("POST", "/v1/client/enroll", admin,
                           {"chat_id": "wrong-admin", "alias": "wrong"}, expected=401)["error"] == "unauthorized"
            assert request("GET", "/v1/sessions", client_enrolled["credential"],
                           expected=401)["error"] == "unauthorized"
            assert request("POST", "/v1/client/enroll", client_enrolled["credential"],
                           {"chat_id": "wrong-session", "alias": "wrong"}, expected=401)["error"] == "unauthorized"
            session = request("POST", "/v1/sessions", admin,
                              {"chat_id": "synthetic-chat", "alias": "fixture"})
            sid = session["session"]["id"]
            key = session["credential"]
            prefix = "/v1/sessions/" + sid
            client = {"chat_id": "synthetic-chat", "worker": "fixture-worker", "epoch": 0}
            lease = request("POST", prefix + "/heartbeat", key, dict(client, status="idle"))
            client["epoch"] = lease["epoch"]
            request("GET", "/v1/sessions", key, expected=401)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                started = time.monotonic()
                pending = pool.submit(request, "POST", prefix + "/wait", key,
                                      dict(client, wait_ms=5000))
                time.sleep(0.15)
                request("POST", "/v1/jobs", admin,
                        {"request_id": "fixture-1", "session_id": sid,
                         "prompt": "synthetic payload", "ttl_seconds": 60})
                job = pending.result(timeout=10)["job"]
                elapsed = time.monotonic() - started
                assert job["id"] == "fixture-1"
                assert elapsed < 5, "wait did not wake early"
            assert request("POST", prefix + "/wait", key, dict(client, wait_ms=10))["job"] is None
            request("POST", prefix + "/ack", key, dict(client, request_id=job["id"], state="submitted"))
            request("POST", prefix + "/ack", key, dict(client, request_id=job["id"], state="completed"))
            assert request("GET", "/v1/jobs/fixture-1", admin)["state"] == "completed"
            request("POST", prefix + "/revoke", admin)
            request("POST", prefix + "/wait", key, dict(client, wait_ms=10), expected=401)
            print(f"HTTP smoke passed: real process, loopback, long-poll wake {elapsed * 1000:.0f} ms, ack, revoke")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    run(Path(sys.argv[1]).resolve())
