# Installation and maintenance

## Local installation

Follow the root README. Keep the application bound to loopback for a workstation install. Run one uvicorn worker; a second collector using the same database is rejected. The application checks/upgrades its Alembic schema at startup; perform explicit migration with a backup before deploying an upgrade.

Configuration uses environment variables, not the old `config.yaml`. For CLI maintenance, export the same `SPARKSCOPE_DATA_DIR`, `SPARKSCOPE_DATABASE_URL` and `SPARKSCOPE_KEY_FILE` as the server. The CLI does not automatically load `.env`. Stop the application for migration, import, restoration and key rotation.

## Shared PostgreSQL installation

`compose.yaml` provides PostgreSQL 17 and the application, with separate database, application-data and encryption-key volumes. From the repository root:

```bash
# Supply a long random URL-safe password through your environment or secret manager.
export POSTGRES_PASSWORD='REPLACE_WITH_A_LONG_RANDOM_URL_SAFE_PASSWORD'
docker compose -f deployment/compose.yaml up -d --build
docker compose -f deployment/compose.yaml exec app /app/.venv/bin/python -m sparkscope.cli setup-code
```

The password is interpolated into the database URL; use URL-safe characters for this Compose example. The application port is published on `127.0.0.1:8010`. For team access, put it behind your HTTPS reverse proxy, export `SPARKSCOPE_ORIGINS` as the exact public HTTPS origin and `SPARKSCOPE_SECURE_COOKIE=1`, then recreate the application container with `docker compose -f deployment/compose.yaml up -d app`. Forward `/api/v1/live` WebSocket upgrades and retain an idle timeout longer than the stream interval. Do not expose PostgreSQL. Create individual viewer/operator/admin accounts in Settings.

Local isolated validation passed image build, Compose startup, verified HTTPS, secure cookies, authenticated WebSockets, origin rejection, container restart persistence and PostgreSQL restore. This does not establish acceptance on the intended server: verify its proxy, host reboot, storage and backup procedures there. See [validation evidence and remaining gates](VALIDATION.md). The current architecture runs one application replica per database; PostgreSQL does not by itself enable multiple collectors.

## Upgrade from the two-device version

1. Stop the old dashboard and retain its code revision, `config.yaml`, database and SSH configuration.
2. Install the new locked dependencies and build the frontend using the README commands. Keep the new default `~/.sparkscope/fleet.db` separate from the legacy database.
3. Run `uv run python -m sparkscope.cli migrate`, then import:

```bash
uv run python -m sparkscope.cli import-legacy \
  --config /absolute/path/to/config.yaml \
  --legacy-db ~/.gb10-dashboard/metrics.db
```

4. Start the application, create its administrator and inspect the imported inventory. Devices are imported paused. Use each device's connection wizard to verify its host key and save working credentials, then resume monitoring.
5. Check recent samples, discovered services and history before retiring the previous installation.

The original YAML example is available in the [legacy revision](https://github.com/canberkys/sparkscope/blob/5fb8304b6cee07001a015acf3202a08f7fc22b38/config.example.yaml); it is an import format, not current application configuration.

Import preserves the source files and creates protected backups. It imports device mapping, thresholds, historical metrics and command outcomes. Legacy alerts become historical resolved records because the old category-level incident semantics cannot safely map to active per-metric incidents. GPU-process snapshots remain in the complete legacy backup. Import has a completion marker to prevent duplicate imports; restore the pre-import database to repeat it. Back up PostgreSQL explicitly before import.

## Backup and restore

For local SQLite:

```bash
uv run python -m sparkscope.cli backup --output /secure/backup/fleet.db
```

Back up `master.secret` separately with restricted access and record the code revision and environment configuration. The default key path is `~/.sparkscope/master.secret`; Compose stores it in the separate secrets volume. A database backup without its matching key cannot recover device credentials, runtime API credentials, pending-job secrets or notification-channel credentials (including private webhook URLs). Retain matching old keys with historical backups.

For Compose PostgreSQL, create a custom-format dump (create a restricted destination directory first). Keep `POSTGRES_PASSWORD` available for Compose interpolation without writing it into shell history:

```bash
umask 077
docker compose -f deployment/compose.yaml exec -T db pg_dump -U sparkscope -d sparkscope -Fc > /secure/backup/fleet.dump
```

Copy the matching Compose key without displaying it in the terminal:

```bash
docker compose -f deployment/compose.yaml cp app:/var/lib/sparkscope-secrets/master.secret /secure/backup/master.secret
chmod 600 /secure/backup/master.secret
```

Use a fresh, uniquely named backup destination each time and store dumps and keys with restricted access. Do not use `docker compose down -v` on an installation you want to retain: it deletes its named data and secret volumes.

To restore SQLite, stop the server and use a fresh data directory containing the backed-up database and matching key. Point `SPARKSCOPE_DATA_DIR` there; set key permissions to 0600 and directory permissions to 0700. Do not overwrite a running SQLite database or retain stale WAL/SHM files from another database. PostgreSQL restoration should target an empty database via `pg_restore`, with the application stopped and the matching key mounted. Verify login, device decryption and collection before resuming use.

Rollback restores the previous code/dependencies/frontend and its corresponding pre-upgrade database/key backup. There is no supported in-place downgrade to the legacy schema. Keep the untouched legacy installation available until hardware acceptance passes.

## Credential rotation and access recovery

To change a device password/key, use its connection wizard: test, explicitly verify the fingerprint, then save the replacement. To change a runtime API key, save its manual service endpoint again.

For encryption-key rotation, stop the application, back up the database and key, generate a Fernet key and prepend it as a new line to `master.secret` while retaining the old lines. Keep file permissions 0600. Then run:

```bash
uv run python -m sparkscope.cli rotate-key
```

All persisted device, service, job and notification-channel secrets are re-encrypted using the first key. Verify restart, device connectivity, authenticated service access and notification-channel configuration before removing old keys from the active file. Sending a channel test is an explicit external action; perform it only when the destination owner expects it. Store the old keys securely with backups that still depend on them. A missing or wrong key for persisted credentials prevents startup.

Recover an administrator password locally using `uv run python -m sparkscope.cli reset-password USERNAME`; it prompts for the new password and revokes that user's sessions. The setup code works only before the first account exists.

## Device privileges and operations

Use an SSH account with the permissions needed for the metrics and explicitly enabled operations. Commands use `sudo -n`; SparkScope does not forward a login password to sudo. Review narrow per-command permissions on each machine rather than granting blanket passwordless sudo. Model metadata is read through SSH to local service endpoints. A manual endpoint handles authenticated or nonstandard runtime ports.

Review operation targets before confirming. A timeout or application restart can leave the remote outcome unknown: inspect the device before manually retrying. The dashboard never automatically retries such operations. Pausing/archiving devices stops subsequent collection; archiving preserves their history.

## macOS autostart

`launchd/sparkscope.plist.example` is optional. Build the frontend, create `~/.sparkscope`, and replace the username/project/uv paths before installing it as a LaunchAgent. Its default port is 8010. Do not run it alongside another collector for the same database.

## Health and notifications

`GET /api/v1/health` reports process liveness. `GET /api/v1/readiness` checks database access and background-worker progress, returning 503 when the application is not ready. Administrators can inspect worker timestamps, stalled jobs and notification backlog under **Settings → Operations & health**. A single unreachable device is a device incident, not necessarily an application readiness failure.

Notification channels are disabled until enabled by an administrator. Configure HTTPS webhooks or TLS-protected SMTP in Settings, then explicitly send a test to the intended destination. Maintenance windows suppress delivery for their scope; they do not stop collection or resolve alarms. Notifications retry with bounded backoff and persistent delivery IDs; receivers should deduplicate by event ID. See [monitoring behavior](MONITORING.md) for saved views, hardware thresholds and delivery semantics.

## GitHub publication

`main` is the published source branch. The Verify SparkScope workflow runs backend and browser checks; its Pages job deploys only the generated `docs/` directory after both checks pass on a main-branch push. Repository Pages uses GitHub Actions, with HTTPS enforced. Pull requests and feature branches do not deploy.

Build and commit the demo before pushing. For a new release, synchronize Python/frontend/API/UI versions and the project metadata in both lockfiles without upgrading dependencies. Preserve existing Git tags. Tag the verified commit and publish release notes from CHANGELOG.md, including upgrade instructions and open acceptance gates. GitHub creates source ZIP/tar archives automatically; this project does not publish prebuilt installers or a container registry image.
