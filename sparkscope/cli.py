"""Local maintenance commands. Run with the application stopped for migration/import/rotation."""

import argparse
import asyncio
import getpass
import os
import secrets
import sqlite3
import time
from pathlib import Path

import yaml
from sqlalchemy import select

from .config import DEFAULT_THRESHOLDS, Settings
from .database import Database
from .models import Alert, Audit, Device, Job, NotificationChannel, Preference, Sample, Service, Session, User
from .security import Vault, hasher, private_file


def backup_sqlite(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    os.chmod(target, 0o600)


async def import_legacy(db, vault, config_path, legacy_path=None, backup_dir=None):
    config = yaml.safe_load(Path(config_path).read_text()) or {}
    backup_dir = Path(backup_dir or Path(config_path).parent / "backups")
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    config_backup = backup_dir / f"config-{stamp}.yaml"
    fd = os.open(config_backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(Path(config_path).read_text())
    if legacy_path and Path(legacy_path).exists():
        backup_sqlite(Path(legacy_path), backup_dir / f"legacy-{stamp}.db")
    mapping = {}
    created = 0
    async with db.session() as s:
        marker = await s.get(Preference, "legacy_import")
        if marker:
            raise RuntimeError("Legacy import already completed. Restore the pre-import backup to repeat it.")
        for name, cfg in config.get("hosts", {}).items():
            # Existing aliases remain usable on this machine after explicit trust.
            row = Device(
                name=cfg.get("display_name", name),
                address=cfg.get("management_ip") or cfg["ssh_alias"],
                port=22,
                username=cfg.get("username", getpass.getuser()),
                group="Imported",
                tags=["legacy"],
                secret=vault.seal({"auth_type": "ssh_config", "ssh_alias": cfg["ssh_alias"]}),
                host_key="",
                paused=True,
                status="paused",
                legacy_name=name,
                info={
                    "ssh_alias": cfg["ssh_alias"],
                    "cluster_peer_ip": cfg.get("cluster_peer_ip", ""),
                    "warnings": ["Imported device is paused. Verify its SSH identity and connection before resuming."],
                },
            )
            s.add(row)
            await s.flush()
            mapping[name] = row.id
            created += 1
        translations = {
            "cpu.temp_max_c": ("cpu_temp_warning", "cpu_temp_critical"),
            "gpu.temp_c": ("gpu_temp_warning", "gpu_temp_critical"),
            "gpu.power_draw_w": ("gpu_power_warning", None),
            "disk.root_used_pct": ("disk_usage_warning", "disk_usage_critical"),
            "memory.used_pct": ("memory_usage_warning", None),
        }
        rules = {k: list(v) for k, v in DEFAULT_THRESHOLDS.items()}
        for metric, (warn, crit) in translations.items():
            rules[metric] = [
                config.get("thresholds", {}).get(warn, rules[metric][0]),
                config.get("thresholds", {}).get(crit, rules[metric][1]) if crit else None,
            ]
        await s.merge(Preference(key="thresholds", value=rules))
        if legacy_path and Path(legacy_path).exists():
            source = sqlite3.connect(f"file:{Path(legacy_path)}?mode=ro", uri=True)
            source.row_factory = sqlite3.Row
            try:
                tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "metrics" in tables:
                    pending = None
                    values = {}
                    for r in source.execute(
                        "SELECT timestamp,host,category,metric,value FROM metrics ORDER BY host,timestamp"
                    ):
                        device_id = mapping.get(r["host"])
                        if not device_id:
                            continue
                        key = (device_id, r["timestamp"])
                        if pending is not None and key != pending:
                            s.add(Sample(device_id=pending[0], ts=pending[1], source="system", values=values))
                            values = {}
                        pending = key
                        values[f"{r['category']}.{r['metric']}"] = r["value"]
                    if pending:
                        s.add(Sample(device_id=pending[0], ts=pending[1], source="system", values=values))
                if "alerts" in tables:
                    for r in source.execute("SELECT * FROM alerts"):
                        if r["host"] not in mapping:
                            continue
                        # Preserve incident timestamps; legacy category-wide semantics cannot be mapped reliably.
                        s.add(
                            Alert(
                                device_id=mapping[r["host"]],
                                metric="legacy." + r["category"],
                                severity=r["severity"],
                                message="[Imported] " + r["message"],
                                first_seen=r["timestamp"],
                                last_seen=r["timestamp"],
                                resolved_at=r["resolved_at"] or time.time(),
                            )
                        )
                if "commands_log" in tables:
                    for r in source.execute("SELECT * FROM commands_log"):
                        s.add(
                            Job(
                                kind="command",
                                owner_id="legacy",
                                status="complete" if r["exit_code"] == 0 else "failed",
                                created_at=r["timestamp"],
                                updated_at=r["timestamp"],
                                data={
                                    "command": r["command_key"],
                                    "device_ids": [mapping.get(r["host"], r["host"])],
                                    "imported": True,
                                },
                                result={
                                    mapping.get(r["host"], r["host"]): {
                                        "exit_code": r["exit_code"],
                                        "stdout": r["stdout"],
                                        "stderr": r["stderr"],
                                        "duration_ms": r["duration_ms"],
                                    }
                                },
                            )
                        )
                # GPU-process snapshots remain in the complete, unmodified legacy backup.
            finally:
                source.close()
        s.add(
            Preference(
                key="legacy_import", value={"timestamp": time.time(), "devices": created, "backup": str(backup_dir)}
            )
        )
        s.add(Audit(actor="local-cli", action="legacy.import", detail={"devices": created}))
    return created


async def main_async(args):
    settings = Settings()
    db = Database(settings.database_url)
    try:
        if args.command == "migrate":
            if db.engine.url.get_backend_name() == "sqlite" and Path(db.engine.url.database).exists():
                backup_sqlite(
                    Path(db.engine.url.database), settings.data_dir / "backups" / f"pre-migration-{int(time.time())}.db"
                )
            await db.migrate()
            print("Schema upgraded to head.")
            return
        await db.migrate()
        if args.command == "setup-code":
            async with db.session() as s:
                exists = await s.scalar(select(User.id).limit(1))
            if exists:
                raise RuntimeError("Administrator already exists; use reset-password locally if needed.")
            print(private_file(settings.data_dir / "setup.secret", secrets.token_urlsafe(32)))
            return
        if args.command == "import-legacy":
            vault = Vault(settings.key_file)
            if db.engine.url.get_backend_name() == "sqlite":
                backup_sqlite(
                    Path(db.engine.url.database), settings.data_dir / "backups" / f"pre-import-{int(time.time())}.db"
                )
            legacy = Path(args.legacy_db).expanduser() if args.legacy_db else None
            count = await import_legacy(db, vault, args.config, legacy, settings.data_dir / "backups")
            print(f"Imported {count} paused devices; verify connections in the dashboard.")
            return
        if args.command == "rotate-key":
            # Operator prepends the new key to the key file; retain old keys until all records rotate.
            vault = Vault(settings.key_file)
            async with db.session() as s:
                for model in (Device, Service, Job, NotificationChannel):
                    for row in (await s.scalars(select(model).where(model.secret != ""))).all():
                        row.secret = vault.rotate(row.secret)
                s.add(Audit(actor="local-cli", action="vault.rotate"))
            print("Credentials rotated to the first key. Verify a backup before removing old keys.")
            return
        if args.command == "reset-password":
            password = getpass.getpass("New password (12+ characters): ")
            if len(password) < 12 or password != getpass.getpass("Repeat new password: "):
                raise RuntimeError("Passwords must match and contain at least 12 characters.")
            from sqlalchemy import delete

            async with db.session() as s:
                user = await s.scalar(select(User).where(User.username == args.username))
                if not user:
                    raise RuntimeError("User not found")
                user.password_hash = await asyncio.to_thread(hasher.hash, password)
                await s.execute(delete(Session).where(Session.user_id == user.id))
                s.add(Audit(actor="local-cli", action="password.reset", target=user.id))
            print("Password updated and sessions revoked.")
            return
        if args.command == "backup":
            if db.engine.url.get_backend_name() != "sqlite":
                raise RuntimeError("Use pg_dump for PostgreSQL; see deployment/OPERATIONS.md.")
            path = Path(args.output).expanduser()
            backup_sqlite(Path(db.engine.url.database), path)
            print(f"Database backup saved to {path}. Back up the master key separately.")
    finally:
        await db.close()


def main():
    parser = argparse.ArgumentParser(description="SparkScope local maintenance")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("migrate", "setup-code", "rotate-key"):
        sub.add_parser(name)
    imp = sub.add_parser("import-legacy")
    imp.add_argument("--config", required=True)
    imp.add_argument("--legacy-db")
    reset = sub.add_parser("reset-password")
    reset.add_argument("username")
    backup = sub.add_parser("backup")
    backup.add_argument("--output", required=True)
    asyncio.run(main_async(parser.parse_args()))


if __name__ == "__main__":
    main()
