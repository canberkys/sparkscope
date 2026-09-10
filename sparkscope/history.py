import math
import time

from sqlalchemy import delete, func, select

from .models import (
    Alert,
    Audit,
    Confirmation,
    FleetEvent,
    Job,
    MaintenanceWindow,
    NotificationDelivery,
    Preference,
    Rollup,
    Sample,
    Session,
)


def accumulate(target, values, summarized=False):
    for metric, value in values.items():
        if summarized:
            item = value
            if not isinstance(item, dict) or not all(
                isinstance(item.get(key), (int, float)) and not isinstance(item[key], bool) and math.isfinite(item[key])
                for key in ("sum", "count", "min", "max")
            ):
                continue
            if item["count"] <= 0 or int(item["count"]) != item["count"] or item["min"] > item["max"]:
                continue
        else:
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                continue
            item = {"sum": value, "count": 1, "min": value, "max": value}
        entry = target.setdefault(metric, {"sum": 0, "count": 0, "min": item["min"], "max": item["max"]})
        entry["sum"] += item["sum"]
        entry["count"] += item["count"]
        entry["min"] = min(entry["min"], item["min"])
        entry["max"] = max(entry["max"], item["max"])


async def summarize(db, resolution, now):
    end = int(now // resolution) * resolution
    async with db.session() as session:
        key = f"rollup_cursor_{resolution}"
        cursor = await session.get(Preference, key)
        earliest = await session.scalar(select(func.min(Sample.ts)))
        if earliest is None:
            return
        start = int((cursor.value["ts"] if cursor else earliest) // resolution) * resolution
        # Process at most one hour each maintenance pass, bounded independently of fleet age.
        stop = min(end, start + max(3600, resolution))
        if stop <= start:
            return
        rows = (await session.scalars(select(Sample).where(Sample.ts >= start, Sample.ts < stop))).all()
        groups = {}
        for row in rows:
            bucket = (row.device_id, row.source, int(row.ts // resolution) * resolution)
            accumulate(groups.setdefault(bucket, {}), row.values)
        for (device, source, ts), values in groups.items():
            session.add(Rollup(device_id=device, source=source, resolution=resolution, ts=ts, values=values))
        if cursor:
            cursor.value = {"ts": stop}
        else:
            session.add(Preference(key=key, value={"ts": stop}))


async def maintain(db):
    now = time.time()
    await summarize(db, 60, now)
    await summarize(db, 900, now)
    async with db.session() as session:
        prefs = await session.get(Preference, "retention")
        policy = prefs.value if prefs else {"raw_hours": 24, "minute_days": 7, "quarter_days": 90, "event_days": 90}
        cursors = (
            await session.scalars(
                select(Preference).where(Preference.key.in_(["rollup_cursor_60", "rollup_cursor_900"]))
            )
        ).all()
        # Never delete raw samples before both resolutions have consumed them.
        safe = min([c.value["ts"] for c in cursors]) if len(cursors) == 2 else 0
        await session.execute(delete(Sample).where(Sample.ts < min(now - policy["raw_hours"] * 3600, safe)))
        await session.execute(
            delete(Rollup).where(Rollup.resolution == 60, Rollup.ts < now - policy["minute_days"] * 86400)
        )
        await session.execute(
            delete(Rollup).where(Rollup.resolution == 900, Rollup.ts < now - policy["quarter_days"] * 86400)
        )
        cutoff = now - policy["event_days"] * 86400
        await session.execute(delete(Audit).where(Audit.ts < cutoff))
        await session.execute(
            delete(FleetEvent).where(FleetEvent.ts < cutoff, FleetEvent.notification_processed.is_(True))
        )
        await session.execute(
            delete(NotificationDelivery).where(
                NotificationDelivery.next_attempt < cutoff, NotificationDelivery.status != "pending"
            )
        )
        await session.execute(
            delete(MaintenanceWindow).where(MaintenanceWindow.end < cutoff, MaintenanceWindow.summarized.is_(True))
        )
        await session.execute(delete(Alert).where(Alert.resolved_at.is_not(None), Alert.resolved_at < cutoff))
        await session.execute(delete(Job).where(Job.updated_at < cutoff, Job.status.not_in(["queued", "running"])))
        await session.execute(delete(Session).where(Session.expires < now))
        await session.execute(delete(Confirmation).where(Confirmation.expires < now))
        for job in (
            await session.scalars(
                select(Job).where(Job.kind == "discovery", Job.created_at < now - 900, Job.secret != "")
            )
        ).all():
            job.secret = ""
            if job.status in ("queued", "awaiting_trust", "running", "complete"):
                job.status = "expired"


async def history(db, device_id, metric, start, end, max_points=300, source="system"):
    resolution = 900 if end - start > 7 * 86400 else 60 if end - start > 3600 else 0
    buckets = {}
    latest = {}
    unknown_latest = set()
    width = max(1, math.ceil((end - start) / max_points))
    async with db.session() as session:
        raw = (
            await session.scalars(
                select(Sample)
                .where(Sample.device_id == device_id, Sample.source == source, Sample.ts >= start, Sample.ts <= end)
                .order_by(Sample.ts)
            )
        ).all()
        valid_raw = []
        for row in raw:
            valid = {}
            accumulate(valid, {metric: row.values.get(metric)})
            if metric in valid:
                valid_raw.append((row.ts, valid))
        rollups = []
        # A narrow historical query can outlive raw retention. Fall back to available
        # summaries without presenting their averages as higher-resolution samples.
        candidates = [resolution] if resolution else []
        if resolution != 900:
            candidates += [r for r in (60, 900) if r not in candidates]
        if resolution or not valid_raw:
            for candidate in candidates:
                rows = (
                    await session.scalars(
                        select(Rollup)
                        .where(
                            Rollup.device_id == device_id,
                            Rollup.source == source,
                            Rollup.resolution == candidate,
                            Rollup.ts >= start,
                            Rollup.ts <= end,
                        )
                        .order_by(Rollup.ts)
                    )
                ).all()
                for row in rows:
                    valid = {}
                    accumulate(valid, {metric: row.values.get(metric)}, True)
                    if metric in valid:
                        rollups.append((row.ts, valid[metric]))
                if rollups:
                    resolution = candidate
                    width = max(width, resolution)
                    break
        covered = set()
        for ts, item in rollups:
            index = int((ts - start) // width)
            accumulate(buckets.setdefault(index, {}), {metric: item}, True)
            unknown_latest.add(index)
            covered.add(int(ts // resolution))
        for ts, valid in valid_raw:
            # Only skip raw readings actually represented by a valid summary.
            if rollups and int(ts // resolution) in covered:
                continue
            index = int((ts - start) // width)
            accumulate(buckets.setdefault(index, {}), valid, True)
            latest[index] = max(latest.get(index, ts), ts)
    return [
        {
            "ts": start + i * width,
            "value": v[metric]["sum"] / v[metric]["count"],
            "min": v[metric]["min"],
            "max": v[metric]["max"],
            "count": v[metric]["count"],
            "bucket_seconds": width,
            # Existing rollups store no actual sample timestamps.
            "last_sample_ts": None if i in unknown_latest else latest.get(i),
        }
        for i, v in sorted(buckets.items())
        if metric in v
    ]
