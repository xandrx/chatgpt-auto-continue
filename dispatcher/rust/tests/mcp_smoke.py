"""Read-only MCP integration check on a disposable loopback process."""
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
from http_smoke import request, BASE, OPENER


def rpc(body, credential=None, session=None, version=None, expected=200, origin=None):
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    if credential:
        headers["Authorization"] = "Bearer " + credential
    if session:
        headers["Mcp-Session-Id"] = session
    if version:
        headers["MCP-Protocol-Version"] = version
    if origin:
        headers["Origin"] = origin
    req = urllib.request.Request(BASE + "/mcp", data=json.dumps(body).encode(),
                                 headers=headers, method="POST")
    try:
        response = OPENER.open(req, timeout=10)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        assert response.status == expected, (response.status, expected)
        assert response.headers.get("Cache-Control") == "no-store"
        sid = response.headers.get("Mcp-Session-Id")
        if expected != 200:
            return None, sid
        if "text/event-stream" in response.headers.get("Content-Type", ""):
            for line in response:
                # Streamable HTTP may emit empty data frames/keep-alives.
                # Only a non-empty JSON-RPC payload can satisfy this request.
                if not line.startswith(b"data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                item = json.loads(payload)
                if item.get("id") == body.get("id"):
                    return item, sid
            raise AssertionError("no matching MCP response; stream ended")
        return json.load(response), sid


def run(binary):
    admin = secrets.token_urlsafe(32)
    observer = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, DISPATCHER_ADMIN_TOKEN=admin,
                   DISPATCHER_OBSERVER_TOKEN=observer,
                   DISPATCHER_DB=str(Path(tmp) / "mcp.sqlite3"))
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
            enrolled = request("POST", "/v1/sessions", admin,
                               {"chat_id": "mcp-fixture", "alias": "fixture"})
            sid = enrolled["session"]["id"]
            request("POST", "/v1/jobs", admin,
                    {"request_id": "mcp-job", "session_id": sid,
                     "prompt": "synthetic private payload", "ttl_seconds": 60})
            initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                          "params": {"protocolVersion": "2025-03-26",
                                     "capabilities": {},
                                     "clientInfo": {"name": "smoke", "version": "1.0"}}}
            rpc(initialize, expected=401)
            rpc(initialize, admin, expected=401)
            rpc(initialize, enrolled["credential"], expected=401)
            rpc(initialize, observer, expected=403, origin="https://evil.example")
            request("GET", "/v1/sessions", observer, expected=401)
            result, session = rpc(initialize, observer)
            assert "result" in result, result
            version = result["result"]["protocolVersion"]
            rpc({"jsonrpc": "2.0", "method": "notifications/initialized"},
                observer, session, version, expected=202)
            listed, _ = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                            observer, session, version)
            names = {tool["name"] for tool in listed["result"]["tools"]}
            assert names == {"list_sessions", "get_task_status"}, names
            listed_sessions, _ = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                      "params": {"name": "list_sessions", "arguments": {"limit": 100}}},
                                     observer, session, version)
            assert not listed_sessions["result"].get("isError"), listed_sessions
            session_text = listed_sessions["result"]["content"][0]["text"]
            assert "mcp-fixture" not in session_text
            assert "fixture" in session_text
            assert "credential" not in session_text

            result, _ = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                             "params": {"name": "get_task_status",
                                        "arguments": {"request_id": "mcp-job"}}},
                            observer, session, version)
            assert not result["result"].get("isError"), result
            text = result["result"]["content"][0]["text"]
            assert "synthetic private payload" not in text
            assert json.loads(text)["state"] == "queued"
            print("MCP smoke passed: initialization, scoped auth, origin rejection, no-store, redacted sessions, metadata-only status")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    run(Path(sys.argv[1]).resolve())
