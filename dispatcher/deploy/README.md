# VPS deployment — Rust Session Dispatcher

Deployment status (2026-11-27): **backend running** on the existing Debian 10 VPS as an enabled `chatgpt-session-dispatcher.service`, bound only to `127.0.0.1:8766`. The public HTTPS origin is `https://csd.guddom.com`; its Let's Encrypt certificate is installed and the Vesta renewal job is present. No Docker container is added. The exact unpacked-extension Origin `chrome-extension://jnhhekmehnkcciglenfdeacocibbocbe` is configured. Commit `4ebd9c6e4e5d74bdee5916b540dcf96f297ccc04` is deployed; SQLite retry-task migration and integrity check passed. Pre-deploy backups are stored at `/var/backups/csd/dispatcher.sqlite3.20261127T204808Z` and `/var/backups/csd/chatgpt-session-dispatcher.20261127T204808Z`. One pilot conversation is enrolled, with remote tasks and final-answer export enabled. The initial `ОК` task was manually verified completed from the user's screenshot; a later `ОК2` attempt was claimed/submitted but its completion acknowledgment is uncertain and awaits user visual confirmation.

## Security boundary

- Nginx proxies only `POST /v1/client/enroll` and per-session `POST /v1/sessions/{id}/{heartbeat,claim,wait,ack}`, plus their CORS `OPTIONS` preflights.
- `GET /v1/sessions`, `POST /v1/sessions`, `/v1/jobs/*`, `/mcp`, `/mcp/operator`, and `/health` are not exposed through Nginx.
- The Rust listener binds only to loopback.
- Exact extension Origin authorization is configured only after the installed browser extension ID is known.
- Admin, observer and MCP operator tokens are distinct random secrets in `/etc/csd/dispatcher.env`; the file is root-owned and readable only by the service group.
- SQLite is stored under `/var/lib/csd`; service runs as an unprivileged `csd` account.
- A limited live pilot is allowed only for one user-selected real conversation and one explicitly approved harmless prompt; keep every other chat disabled. Multi-chat/unattended operation remains gated on the browser E2E matrix in `docs/DISPATCHER-EXTENSION-E2E.md`.

## Files

- `chatgpt-session-dispatcher.service` — systemd unit.
- `csd.guddom.com.nginx.conf` — location include for the dedicated Vesta-managed subdomain; only client enrollment and session worker routes are proxied.
- `csd.guddom.com.php-fpm-pool.conf` — minimal Vesta compatibility pool for the generated vhost template; ondemand, one worker maximum, loopback only. No PHP application is deployed.
- Static Linux binary is built by CI for `x86_64-unknown-linux-musl`; this avoids dependence on the VPS's old glibc 2.28.

## Runtime environment

Required: `DISPATCHER_ADMIN_TOKEN` (32–512 bytes).

Optional, each distinct and 32–512 bytes:
- `DISPATCHER_OBSERVER_TOKEN`
- `DISPATCHER_MCP_OPERATOR_TOKEN`
- `DISPATCHER_ENROLL_TOKEN` (not used when exact extension Origin is configured)
- `DISPATCHER_EXTENSION_ORIGIN=chrome-extension://<32-character-extension-id>` (set after extension installation)

The database path is set by systemd to `/var/lib/csd/dispatcher.sqlite3`.

## Verified on 2026-11-27

- Local `/health` returns `{"ok":true,"protocol":1,"version":"0.1.0"}`.
- systemd service is active and enabled; listener is exactly `127.0.0.1:8766`.
- `/etc/csd/dispatcher.env` is `root:csd` mode `0640`; SQLite is `csd:csd` mode `0600`.
- Public `/`, `/health`, `/mcp`, `/v1/jobs`, `/v1/sessions`, and session revoke paths return 404.
- The configured extension Origin receives a public CORS preflight response of 204 with credentials enabled; a different extension Origin receives 403.
- The service was restarted after setting `DISPATCHER_EXTENSION_ORIGIN`; `/health` and the loopback listener were verified afterward.
- A session worker request without its cookie returns 401; HTTP POST enrollment redirects to HTTPS.
- Nginx configuration test passes; the Let's Encrypt renewal cron job is present. Vesta's ACME polling parser was corrected to read the JSON `status` field independent of field order; the reproducible one-line patch is `vesta-acme-status-parser.patch`, and the original script is backed up as `/usr/local/vesta/bin/v-add-letsencrypt-domain.orig-20261127`.
- One user-selected pilot session is enrolled and online; remote task delivery and final-answer export are enabled. The initial `ОК` prompt was verified completed from the user's screenshot. The subsequent `ОК2` attempt was claimed and acknowledged as submitted, then ended `uncertain`; it was not automatically replayed.
- Durable retry scheduler verified on the VPS using a separate unregistered test session: attempt 1 expired, attempts 2 and 3 were created after the 30-second delay, and the task plus its last job were canceled after the third expiry. The test session was then revoked.
- Retry policy: maximum 3 attempts, 30 seconds between attempts, 10-minute total delivery window. Only jobs that expire while still queued are retried. Claimed, submitted, and uncertain jobs are never replayed.

## Operational checks

- `systemctl status chatgpt-session-dispatcher`
- `journalctl -u chatgpt-session-dispatcher -n 100 --no-pager`
- `curl --fail http://127.0.0.1:8766/health`
- `nginx -t` before every Nginx reload.
- Confirm external `https://csd.guddom.com/health` returns 404 and `/mcp` returns 404; only the explicitly listed extension routes should reach the backend.
