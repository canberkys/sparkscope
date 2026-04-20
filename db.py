"""SQLite database layer — schema, inserts, queries, retention."""

import aiosqlite
import asyncio
import os
import time
from pathlib import Path

DB_PATH: str = ""
_shared_conn: aiosqlite.Connection | None = None
_conn_lock = asyncio.Lock()


def set_db_path(path: str):
    global DB_PATH
    DB_PATH = os.path.expanduser(path)
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


async def _get_conn() -> aiosqlite.Connection:
    """Return the shared persistent connection, opening it on first use."""
    global _shared_conn
    if _shared_conn is None:
        async with _conn_lock:
            if _shared_conn is None:
                conn = await aiosqlite.connect(DB_PATH)
                await conn.execute("PRAGMA journal_mode=WAL")
                await conn.execute("PRAGMA synchronous=NORMAL")
                await conn.execute("PRAGMA busy_timeout=5000")
                conn.row_factory = aiosqlite.Row
                _shared_conn = conn
    return _shared_conn


async def close_db():
    global _shared_conn
    if _shared_conn is not None:
        await _shared_conn.close()
        _shared_conn = None


async def init_db():
    conn = await _get_conn()
    await conn.executescript("""
        CREATE TABLE IF NOT EXISTS metrics (
            timestamp INTEGER NOT NULL,
            host TEXT NOT NULL,
            category TEXT NOT NULL,
            metric TEXT NOT NULL,
            value REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_lookup
            ON metrics(host, category, metric, timestamp);
        CREATE INDEX IF NOT EXISTS idx_metrics_retention
            ON metrics(timestamp);

        CREATE TABLE IF NOT EXISTS gpu_processes (
            timestamp INTEGER NOT NULL,
            host TEXT NOT NULL,
            pid INTEGER NOT NULL,
            process_name TEXT,
            mem_mb INTEGER
        );

        CREATE TABLE IF NOT EXISTS commands_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            host TEXT NOT NULL,
            command_key TEXT NOT NULL,
            command_text TEXT NOT NULL,
            exit_code INTEGER,
            stdout TEXT,
            stderr TEXT,
            duration_ms INTEGER
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            host TEXT NOT NULL,
            category TEXT NOT NULL,
            severity TEXT NOT NULL,
            message TEXT NOT NULL,
            resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_active
            ON alerts(resolved_at, timestamp);
    """)
    await conn.commit()


async def insert_metrics(host: str, metrics: dict, ts: int | None = None):
    """Insert a flat dict of {category.metric: value} into DB."""
    ts = ts or int(time.time())
    conn = await _get_conn()
    rows = []
    for key, value in metrics.items():
        if value is None:
            continue
        parts = key.split(".", 1)
        if len(parts) != 2:
            continue
        category, metric = parts
        try:
            rows.append((ts, host, category, metric, float(value)))
        except (ValueError, TypeError):
            continue
    if rows:
        await conn.executemany(
            "INSERT INTO metrics (timestamp, host, category, metric, value) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        await conn.commit()


async def insert_gpu_processes(host: str, processes: list[dict], ts: int | None = None):
    ts = ts or int(time.time())
    conn = await _get_conn()
    rows = [(ts, host, p["pid"], p.get("name", ""), p.get("mem_mb", 0)) for p in processes]
    if rows:
        await conn.executemany(
            "INSERT INTO gpu_processes (timestamp, host, pid, process_name, mem_mb) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        await conn.commit()


async def insert_command_log(host: str, key: str, command: str, exit_code: int, stdout: str, stderr: str, duration_ms: int):
    ts = int(time.time())
    conn = await _get_conn()
    await conn.execute(
        "INSERT INTO commands_log (timestamp, host, command_key, command_text, exit_code, stdout, stderr, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ts, host, key, command, exit_code, stdout, stderr, duration_ms),
    )
    await conn.commit()


async def get_latest_metrics(host: str | None = None) -> dict:
    """Get the most recent value for each host/category/metric combo."""
    conn = await _get_conn()
    if host:
        query = """
            SELECT host, category, metric, value, MAX(timestamp) as ts
            FROM metrics WHERE host = ?
            GROUP BY host, category, metric
        """
        cursor = await conn.execute(query, (host,))
    else:
        query = """
            SELECT host, category, metric, value, MAX(timestamp) as ts
            FROM metrics
            GROUP BY host, category, metric
        """
        cursor = await conn.execute(query)
    rows = await cursor.fetchall()

    result = {}
    for row in rows:
        h = row["host"]
        if h not in result:
            result[h] = {}
        result[h][f"{row['category']}.{row['metric']}"] = row["value"]
    return result


async def get_metric_history(host: str, category: str, metric: str, from_ts: int, to_ts: int) -> list[dict]:
    conn = await _get_conn()
    cursor = await conn.execute(
        "SELECT timestamp, value FROM metrics WHERE host=? AND category=? AND metric=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp",
        (host, category, metric, from_ts, to_ts),
    )
    rows = await cursor.fetchall()
    return [{"ts": r["timestamp"], "value": r["value"]} for r in rows]


async def get_command_history(limit: int = 50) -> list[dict]:
    conn = await _get_conn()
    cursor = await conn.execute(
        "SELECT * FROM commands_log ORDER BY timestamp DESC LIMIT ?", (limit,)
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def insert_alert(host: str, category: str, severity: str, message: str):
    ts = int(time.time())
    conn = await _get_conn()
    # Check for existing unresolved alert with same host+category+message
    cursor = await conn.execute(
        "SELECT id FROM alerts WHERE host=? AND category=? AND message=? AND resolved_at IS NULL",
        (host, category, message),
    )
    existing = await cursor.fetchone()
    if existing:
        await conn.execute("UPDATE alerts SET timestamp=? WHERE id=?", (ts, existing["id"]))
    else:
        await conn.execute(
            "INSERT INTO alerts (timestamp, host, category, severity, message) VALUES (?, ?, ?, ?, ?)",
            (ts, host, category, severity, message),
        )
    await conn.commit()


async def resolve_alert(alert_id: int):
    conn = await _get_conn()
    await conn.execute("UPDATE alerts SET resolved_at=? WHERE id=?", (int(time.time()), alert_id))
    await conn.commit()


async def resolve_alerts_by_category(host: str, category: str):
    conn = await _get_conn()
    await conn.execute(
        "UPDATE alerts SET resolved_at=? WHERE host=? AND category=? AND resolved_at IS NULL",
        (int(time.time()), host, category),
    )
    await conn.commit()


async def get_active_alerts() -> list[dict]:
    conn = await _get_conn()
    cursor = await conn.execute(
        "SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY timestamp DESC"
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_recent_alerts(hours: int = 24) -> list[dict]:
    conn = await _get_conn()
    cutoff = int(time.time()) - hours * 3600
    cursor = await conn.execute(
        "SELECT * FROM alerts WHERE timestamp > ? ORDER BY timestamp DESC", (cutoff,)
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def run_retention(retention_hours: int = 24, vacuum: bool = False):
    cutoff = int(time.time()) - retention_hours * 3600
    conn = await _get_conn()
    await conn.execute("DELETE FROM metrics WHERE timestamp < ?", (cutoff,))
    await conn.execute("DELETE FROM gpu_processes WHERE timestamp < ?", (cutoff,))
    await conn.commit()
    if vacuum:
        # VACUUM must run outside a transaction
        await conn.execute("VACUUM")
