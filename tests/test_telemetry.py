import asyncio
import time

from conftest import onboard
from sqlalchemy import select

from sparkscope.alerts import AlertEngine
from sparkscope.history import history, summarize
from sparkscope.models import Alert, Device, Rollup, Sample
from sparkscope.parsers import MetricParser
from sparkscope.runtimes import prometheus


async def test_incident_identity_and_independent_recovery(env):
    app, _, _ = env
    engine = AlertEngine()
    ts = time.time()
    for i, temp in enumerate([91, 92, 93, 94, 95]):
        async with app.state.db.session() as s:
            await engine.evaluate(s, "node", {"gpu.temp_c": temp, "gpu.power_draw_w": 220}, ts + i)
    async with app.state.db.session() as s:
        rows = (await s.scalars(select(Alert).where(Alert.resolved_at.is_(None)))).all()
        assert len(rows) == 2
        temperature = next(a for a in rows if a.metric == "gpu.temp_c")
        assert temperature.first_seen == ts + 2 and temperature.last_seen == ts + 4
        assert temperature.severity == "critical" and temperature.occurrences == 3
    for i in range(3):
        async with app.state.db.session() as s:
            await engine.evaluate(s, "node", {"gpu.temp_c": 95, "gpu.power_draw_w": 100}, ts + 5 + i)
    async with app.state.db.session() as s:
        active = (await s.scalars(select(Alert).where(Alert.resolved_at.is_(None)))).all()
        assert [a.metric for a in active] == ["gpu.temp_c"]
    # Missing readings do not count as normal or consecutive violations.
    for i in range(3):
        async with app.state.db.session() as s:
            await engine.evaluate(s, "node", {}, ts + 8 + i)
    async with app.state.db.session() as s:
        assert len((await s.scalars(select(Alert).where(Alert.resolved_at.is_(None)))).all()) == 1


async def test_smart_survives_fast_poll_and_slow_node_is_isolated(env):
    app, c, t = env
    d = await onboard(c)
    other = await onboard(c, "Node 2", "10.0.0.11")
    async with app.state.db.session() as s:
        row = await s.get(Device, d["id"])
        row2 = await s.get(Device, other["id"])
    await app.state.collector.poll_smart(row)
    await app.state.collector.poll_system(row)
    detail = (await c.get("/api/v1/devices/" + d["id"])).json()
    assert round(detail["metrics"]["nvme.temp_c"], 1) == 39.9
    assert detail["metrics"]["memory.swap_total_kb"] == 1000000
    t.delay[row.id] = 0.3
    slow = asyncio.create_task(app.state.collector.poll_system(row))
    start = time.monotonic()
    await app.state.collector.poll_system(row2)
    assert time.monotonic() - start < 0.2
    await slow


async def test_rollups_preserve_peaks_and_are_idempotent(env):
    app, _, _ = env
    ts = int(time.time() // 60) * 60 - 600
    async with app.state.db.session() as s:
        for i, v in enumerate([10, 90, 20]):
            s.add(Sample(device_id="node", source="system", ts=ts + i, values={"gpu.util_pct": v}))
    await summarize(app.state.db, 60, time.time())
    await summarize(app.state.db, 60, time.time())
    async with app.state.db.session() as s:
        rows = (await s.scalars(select(Rollup))).all()
        assert len(rows) == 1
        assert rows[0].values["gpu.util_pct"]["max"] == 90
        assert rows[0].values["gpu.util_pct"]["count"] == 3
    points = await history(app.state.db, "node", "gpu.util_pct", ts - 4000, time.time())
    assert max(p["max"] for p in points) == 90


def test_parser_unknown_gpu_and_reboot_counters():
    pool = MetricParser({})
    assert pool._parse_gpu("20, 10, [N/A], [N/A], [N/A], 50, 60, 100, 900, 900")["gpu.mem_total_mb"] is None
    assert pool._parse_thermal("") == {}
    # GPU-idle is not an overheating/power throttle incident.
    assert pool._parse_gpu_health("0, 0, 0x0000000000000001, 4, Enabled")["gpu.throttle_active"] == 0
    assert pool._parse_gpu_health("0, 0, 0x0000000000000008, 4, Enabled")["gpu.throttle_active"] == 1
    pool._prev_disk["node"] = {
        "reads": 100,
        "writes": 100,
        "read_sec": 1000,
        "write_sec": 1000,
        "ts": time.monotonic() - 5,
    }
    assert "disk.read_mbps" not in pool._parse_disk("node", "259 0 nvme0n1 1 0 1 0 1 0 1 0 0 0 0", "")


def test_prometheus_labels_gauges_and_nonfinite():
    result = prometheus(
        'vllm:generation_tokens_total{engine="0"} 100\nvllm:generation_tokens_total{engine="1"} 200\nvllm:kv_cache_usage_perc{engine="0"} 0.5\nvllm:kv_cache_usage_perc{engine="1"} 0.7\nvllm:num_requests_running_extra 999\nvllm:num_requests_waiting NaN'
    )
    assert result["generation_tokens_total"] == 300
    assert result["kv_cache_pct"] == 60
    assert "requests_running" not in result and "requests_waiting" not in result
