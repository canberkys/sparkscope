"""Synthetic slow-device/outage/recovery run in a fresh temporary SQLite DB.

Example: uv run python scripts/fault_smoke.py --duration 1800 --devices 50
This is application fault injection, not SSH hardware or reference-server soak.
"""

import argparse
import asyncio
import hashlib
import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path

from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sparkscope import load_test
from sparkscope.models import Preference, Rollup, Sample


async def run(args):
    failures = set()
    recovered = set()
    delayed = set()
    delayed_smart = set()
    delayed_services = set()
    observations = []
    observation_errors = []
    captured = {}
    root = Path(__file__).resolve().parents[1]
    source_manifest = {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted([*root.glob("sparkscope/*.py"), *root.glob("migrations/versions/*.py"), Path(__file__)])
    }
    started = time.monotonic()

    class FaultTransport(load_test.SyntheticTransport):
        async def connection(self, device):
            conn = await super().connection(device)
            conn.device_number = int(device.name.split("-")[-1])
            return conn

        async def smart(self, device):
            number = int(device.name.split("-")[-1])
            if number % 17 == 0:
                delayed_smart.add(number)
                await asyncio.sleep(args.slow_seconds)
            return await super().smart(device)

        async def run_on(self, conn, command, timeout=30, stdin=None):
            number = getattr(conn, "device_number", 0)
            if number and number % 13 == 0:
                delayed_services.add(number)
                await asyncio.sleep(args.slow_seconds)
            return await super().run_on(conn, command, timeout, stdin)

        async def system(self, device):
            number = int(device.name.split("-")[-1])
            elapsed = time.monotonic() - started
            if number % 11 == 0 and elapsed % args.outage_period < args.outage_seconds:
                failures.add(number)
                await asyncio.sleep(args.timeout_seconds)
                raise TimeoutError("Synthetic outage")
            if number % 7 == 0:
                delayed.add(number)
                await asyncio.sleep(args.slow_seconds)
            result = await super().system(device)
            if number in failures:
                recovered.add(number)
            return result

    original_create = load_test.create_app

    def create_observed_app(settings, transport):
        app = original_create(settings, transport)
        captured.update(app=app, settings=settings)
        migrate = app.state.db.migrate
        seeded = False

        async def migrate_with_backlog():
            nonlocal seeded
            await migrate()
            if seeded:
                return
            seeded = True
            end = int(time.time() // 300) * 300
            async with app.state.db.session() as session:
                for ts in range(end - args.backlog_hours * 3600, end, 300):
                    for number in range(args.devices):
                        session.add(
                            Sample(
                                device_id=f"backlog-fixture-{number}",
                                source="system",
                                ts=ts,
                                values={"gpu.util_pct": 42, "memory.used_pct": 30, "cpu.temp_max_c": 50},
                            )
                        )
            captured["seeded_samples"] = args.backlog_hours * 12 * args.devices

        app.state.db.migrate = migrate_with_backlog
        return app

    async def observe():
        while "app" not in captured or "seeded_samples" not in captured:
            await asyncio.sleep(0.05)
        app, settings = captured["app"], captured["settings"]
        try:
            async with app.state.db.session() as session:
                counts = {}
                for model in (Sample, Rollup):
                    counts[model.__tablename__] = await session.scalar(select(func.count()).select_from(model))
                cursors = (
                    await session.scalars(
                        select(Preference).where(Preference.key.in_(["rollup_cursor_60", "rollup_cursor_900"]))
                    )
                ).all()
                expired_raw = await session.scalar(
                    select(func.count()).select_from(Sample).where(Sample.ts < time.time() - 86400)
                )
            rss = subprocess.run(["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True, text=True)
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            observations.append(
                {
                    "elapsed_s": round(time.monotonic() - started, 2),
                    "rss_mb": round(int(rss.stdout.strip()) / 1024, 2) if rss.returncode == 0 else None,
                    "peak_rss_mb": round(peak / (1024 * 1024 if sys.platform == "darwin" else 1024), 2),
                    "database_bytes": sum(file.stat().st_size for file in settings.data_dir.glob("fleet.db*")),
                    "counts": counts,
                    "expired_raw_samples": expired_raw,
                    "rollup_lag_seconds": {
                        cursor.key: round(time.time() - cursor.value["ts"], 2) for cursor in cursors
                    },
                    "collector": json.loads(
                        json.dumps(
                            {key: value for key, value in app.state.collector.metrics.items() if key != "last_progress"}
                        )
                    ),
                    "progress_entries": len(app.state.collector.metrics.get("last_progress", {})),
                }
            )
        except Exception as exc:
            observation_errors.append(type(exc).__name__)

    async def periodic_observer():
        while True:
            await observe()
            await asyncio.sleep(60)

    load_test.SyntheticTransport = FaultTransport
    load_test.create_app = create_observed_app
    # External URLs are deliberately not accepted: no possibility of targeting
    # workstation or real fleet data. The base harness creates TemporaryDirectory.
    args.database_url = ""
    observer = asyncio.create_task(periodic_observer())
    # Capture the final observation before the harness closes its DB/removes files.
    original_close = None

    async def install_final_observer():
        nonlocal original_close
        while "app" not in captured:
            await asyncio.sleep(0.01)
        original_close = captured["app"].state.db.close

        async def close_observed():
            observer.cancel()
            await asyncio.gather(observer, return_exceptions=True)
            await observe()
            await original_close()

        captured["app"].state.db.close = close_observed

    installer = asyncio.create_task(install_final_observer())
    try:
        code = await load_test.run(args)
    finally:
        observer.cancel()
        installer.cancel()
        await asyncio.gather(observer, installer, return_exceptions=True)
    report = json.loads(args.output.read_text())
    report["fault_injection"] = {
        "slow_seconds": args.slow_seconds,
        "timeout_seconds": args.timeout_seconds,
        "outage_seconds": args.outage_seconds,
        "outage_period": args.outage_period,
        "delayed_devices": len(delayed),
        "delayed_smart_devices": len(delayed_smart),
        "delayed_service_devices": len(delayed_services),
        "outage_devices": len(failures),
        "recovered_devices": len(recovered),
        "all_injected_outages_recovered": bool(failures) and failures == recovered,
    }
    report["full_24h_gate"] = False
    report["reference_server_acceptance"] = False
    report["source_snapshot"] = args.source_snapshot
    report["source_sha256"] = source_manifest
    report["observations"] = observations
    report["observation_errors"] = observation_errors
    report["backlog_seeded_samples"] = captured.get("seeded_samples", 0)
    report["backlog_caught_up"] = (
        bool(observations and observations[-1]["rollup_lag_seconds"])
        and max(observations[-1]["rollup_lag_seconds"].values()) <= 1200
    )
    report["passed"] = report["passed"] and bool(failures) and failures == recovered
    report["passed"] = report["passed"] and not observation_errors and report["backlog_caught_up"]
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"fault_report": str(args.output), "passed": report["passed"], **report["fault_injection"]}))
    return code or (0 if report["passed"] else 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=1800)
    parser.add_argument("--devices", type=int, default=50)
    parser.add_argument("--clients", type=int, default=5)
    parser.add_argument("--port", type=int, default=8022)
    parser.add_argument("--slow-seconds", type=float, default=8)
    parser.add_argument("--timeout-seconds", type=float, default=8)
    parser.add_argument("--outage-seconds", type=float, default=30)
    parser.add_argument("--outage-period", type=float, default=120)
    parser.add_argument("--backlog-hours", type=int, default=26)
    parser.add_argument("--source-snapshot", default="working-tree")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if any(os.getenv(key) for key in ("SPARKSCOPE_KEY_FILE", "SPARKSCOPE_DATABASE_URL", "SPARKSCOPE_SECURE_COOKIE")):
        parser.error("Unset SparkScope database/key/cookie overrides before running this isolated fixture")
    if args.duration < args.outage_seconds + args.timeout_seconds + 10:
        parser.error("duration must allow the injected outage to recover")
    if not 11 <= args.devices <= 50 or not 1 <= args.clients <= 20:
        parser.error("devices must be 11–50 and clients 1–20")
    if min(args.slow_seconds, args.timeout_seconds, args.outage_seconds) <= 0:
        parser.error("fault durations must be positive")
    if args.outage_period <= args.outage_seconds + args.timeout_seconds + 10:
        parser.error("outage period must leave time for recovery")
    if not 0 <= args.backlog_hours <= 48:
        parser.error("backlog hours must be 0–48")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    raise SystemExit(asyncio.run(run(args)))
