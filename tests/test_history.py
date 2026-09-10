import math

import pytest

from sparkscope.history import accumulate, history
from sparkscope.models import Rollup, Sample


@pytest.fixture
async def db(env):
    # Reuse the isolated per-engine fixture so history semantics run on both engines.
    yield env[0].state.db


async def add_raw(db, samples):
    async with db.session() as session:
        for ts, value in samples:
            session.add(Sample(device_id="node", source="system", ts=ts, values={"metric": value}))


async def add_rollup(db, ts, resolution, total, count, low, high):
    async with db.session() as session:
        session.add(
            Rollup(
                device_id="node",
                source="system",
                ts=ts,
                resolution=resolution,
                values={"metric": {"sum": total, "count": count, "min": low, "max": high}},
            )
        )


async def test_irregular_samples_keep_gaps_zero_and_actual_latest_time(db):
    await add_raw(db, [(101, 0), (107, 10), (139, 20), (140, None)])
    points = await history(db, "node", "metric", 100, 150, max_points=5)
    assert points == [
        {"ts": 100, "value": 5, "min": 0, "max": 10, "count": 2, "bucket_seconds": 10, "last_sample_ts": 107},
        {"ts": 130, "value": 20, "min": 20, "max": 20, "count": 1, "bucket_seconds": 10, "last_sample_ts": 139},
    ]


async def test_empty_and_single_sample(db):
    assert await history(db, "node", "metric", 100, 200) == []
    await add_raw(db, [(123.5, 0)])
    points = await history(db, "node", "metric", 100, 200)
    assert len(points) == 1
    assert points[0]["last_sample_ts"] == 123.5
    assert points[0]["value"] == 0
    assert points[0]["count"] == 1


async def test_rollups_weight_counts_without_double_counting_raw(db):
    await add_rollup(db, 0, 60, 30, 3, 0, 20)
    await add_rollup(db, 60, 60, 100, 1, 100, 100)
    await add_raw(db, [(5, 0), (65, 100), (130, 50)])
    points = await history(db, "node", "metric", 0, 7200, max_points=60)
    assert points[0] == {
        "ts": 0,
        "value": 32.5,
        "min": 0,
        "max": 100,
        "count": 4,
        "bucket_seconds": 120,
        "last_sample_ts": None,
    }
    assert points[1]["count"] == 1
    assert points[1]["last_sample_ts"] == 130
    assert sum(p["value"] * p["count"] for p in points) / sum(p["count"] for p in points) == 36


@pytest.mark.parametrize("resolution", [60, 900])
async def test_narrow_historical_query_falls_back_to_retained_rollups(db, resolution):
    await add_rollup(db, 1800, resolution, 0, 2, 0, 0)
    # A recent sample missing this metric must not hide its retained history.
    await add_raw(db, [(3500, None)])
    points = await history(db, "node", "metric", 1800, 3600)
    assert len(points) == 1
    assert points[0]["bucket_seconds"] == resolution
    assert points[0]["last_sample_ts"] is None
    assert points[0]["count"] == 2
    assert points[0]["value"] == 0


async def test_missing_rollup_bucket_preserves_available_raw(db):
    await add_rollup(db, 0, 60, 10, 1, 10, 10)
    await add_rollup(db, 180, 60, 20, 1, 20, 20)
    await add_raw(db, [(75, 30), (190, 20)])
    points = await history(db, "node", "metric", 0, 7200)
    assert [p["ts"] for p in points] == [0, 60, 180]
    assert [p["count"] for p in points] == [1, 1, 1]
    assert points[1]["last_sample_ts"] == 75
    assert all(p["bucket_seconds"] == 60 for p in points)


def test_nonfinite_and_invalid_summaries_are_ignored():
    raw = {}
    accumulate(raw, {"nan": math.nan, "inf": math.inf, "bool": True, "none": None, "zero": 0})
    assert set(raw) == {"zero"}
    summaries = {}
    for count, total in [(0, 10), (-1, 10), (1, math.inf), (math.nan, 1), (1.5, 10)]:
        accumulate(summaries, {"metric": {"sum": total, "count": count, "min": 0, "max": 10}}, True)
    assert summaries == {}
