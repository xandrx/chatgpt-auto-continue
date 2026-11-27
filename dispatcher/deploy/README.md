# VPS deployment — Rust Session Dispatcher

Target: dedicated `csd` systemd service on the existing Debian 10 VPS, bound to loopback `127.0.0.1:8766`. The public HTTPS origin is `https://csd.guddom.com`. No Docker container is added.

## Security boundary

- Nginx proxies only `POST /v1/client/enroll` and per-session `POST /v1/sessions/{id}/{heartbeat,claim,wait,ack}`, plus their CORS `OPTIONS` preflights.
- `GET /v1/sessions`, `POST /v1/sessions`, `/v1/jobs/*`, `/mcp`, `/mcp/operator`, and `/health` are not exposed through Nginx.
- The Rust listener binds only to loopback.
- Exact extension Origin authorization is configured only after the installed browser extension ID is known.
- Admin, observer and MCP operator tokens are distinct random secrets in `/etc/csd/dispatcher.env`; the file is root-owned and readable only by the service group.
- SQLite is stored under `/var/lib/csd`; service runs as an unprivileged `csd` account.
- Never enable remote tasks for a real conversation until the browser E2E matrix in `docs/DISPATCHER-EXTENSION-E2E.md` has passed.

## Files

- `chatgpt-session-dispatcher.service` — systemd unit.
- `csd.guddom.com.nginx.conf` — location include for the dedicated Vesta-managed subdomain.
- Static Linux binary is built by CI for `x86_64-unknown-linux-musl`; this avoids dependence on the VPS's old glibc 2.28.

## Runtime environment

Required: `DISPATCHER_ADMIN_TOKEN` (32–512 bytes).

Optional, each distinct and 32–512 bytes:
- `DISPATCHER_OBSERVER_TOKEN`
- `DISPATCHER_MCP_OPERATOR_TOKEN`
- `DISPATCHER_ENROLL_TOKEN` (not used when exact extension Origin is configured)
- `DISPATCHER_EXTENSION_ORIGIN=chrome-extension://<32-character-extension-id>` (set after extension installation)

The database path is set by systemd to `/var/lib/csd/dispatcher.sqlite3`.

## Operational checks

- `systemctl status chatgpt-session-dispatcher`
- `journalctl -u chatgpt-session-dispatcher -n 100 --no-pager`
- `curl --fail http://127.0.0.1:8766/health`
- `nginx -t` before every Nginx reload.
- Confirm external `https://csd.guddom.com/health` returns 404 and `/mcp` returns 404; only the explicitly listed extension routes should reach the backend.
