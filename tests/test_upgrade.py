"""Upgrade and startup checks use only temporary databases and synthetic secrets."""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, Table, select

from sparkscope.api import create_app
from sparkscope.config import Settings
from sparkscope.database import Database
from sparkscope.models import Alert, Device, Job, NotificationChannel, Preference, Rollup, Sample, Service
from sparkscope.security import Vault


@pytest.mark.parametrize("kind", ["device", "service", "job", "notification"])
async def test_startup_checks_every_encrypted_record_before_collecting(tmp_path, kind):
    settings = Settings(data_dir=tmp_path)
    vault = Vault(settings.key_file)
    db = Database(settings.database_url)
    await db.migrate()
    valid = vault.seal({"password": "synthetic-only"})
    bad = "invalid-synthetic-ciphertext"
    constructors = {
        "device": lambda i, secret: Device(id=i, name=i, address=i, username="test", secret=secret),
        "service": lambda i, secret: Service(
            id=i, device_id="node", provider="vllm", port=8000 if i == "a" else 8001, secret=secret
        ),
        "job": lambda i, secret: Job(id=i, kind="discovery", owner_id="test", secret=secret),
        "notification": lambda i, secret: NotificationChannel(id=i, name=i, kind="webhook", secret=secret),
    }
    async with db.session() as session:
        session.add_all([constructors[kind]("a", valid), constructors[kind]("z", bad)])
    await db.close()
    before = settings.key_file.read_bytes()
    app = create_app(settings)
    called = []

    async def forbidden_start():
        called.append(True)

    app.state.collector.start = forbidden_start
    with pytest.raises(RuntimeError, match="cannot decrypt saved credentials"):
        async with app.router.lifespan_context(app):
            pytest.fail("Corrupt secret must prevent startup")
    assert called == []
    assert settings.key_file.read_bytes() == before


async def test_baseline_upgrade_preserves_credentials_and_legacy_gpu_history(tmp_path):
    settings = Settings(data_dir=tmp_path)
    vault = Vault(settings.key_file)
    ciphertext = vault.seal({"password": "synthetic-upgrade-only"})
    key_before = settings.key_file.read_bytes()
    db = Database(settings.database_url)
    legacy_sample = {"gpu.0.util_pct": 40, "gpu.util_pct": 40}
    legacy_rollup = {"gpu.0.util_pct": {"min": 30, "max": 50, "sum": 80, "count": 2}}

    def baseline(conn):
        config = Config()
        config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
        config.attributes["connection"] = conn
        command.upgrade(config, "0001")
        meta = MetaData()

        def insert(name, values):
            conn.execute(Table(name, meta, autoload_with=conn).insert().values(**values))

        insert(
            "devices",
            dict(
                id="node",
                name="Legacy node",
                address="test.invalid",
                port=22,
                username="test",
                group="Default",
                tags=[],
                secret=ciphertext,
                host_key="test-pinned-key",
                paused=True,
                archived=False,
                info={"cluster_name": "Existing"},
                latest={},
                status="offline",
                created_at=1,
                revision=3,
            ),
        )
        insert("samples", dict(device_id="node", source="system", ts=1, values=legacy_sample))
        insert("rollups", dict(device_id="node", source="system", resolution=60, ts=0, values=legacy_rollup))
        insert(
            "fleet_alerts",
            dict(
                id="old-alert",
                device_id="node",
                metric="gpu.temp_c",
                severity="warning",
                message="Legacy incident",
                first_seen=1,
                last_seen=2,
                occurrences=2,
            ),
        )
        insert("preferences", dict(key="thresholds", value={"gpu.temp_c": [70, 85]}))

    async with db.engine.begin() as conn:
        await conn.run_sync(baseline)
    await db.migrate()
    await db.migrate()  # Repeated startup migration is idempotent.
    async with db.session() as session:
        device = await session.get(Device, "node")
        assert device.secret == ciphertext and device.host_key == "test-pinned-key"
        assert device.info == {"cluster_name": "Existing"} and device.revision == 3
        assert vault.open(device.secret) == {"password": "synthetic-upgrade-only"}
        assert (await session.scalar(select(Sample))).values == legacy_sample
        assert (await session.scalar(select(Rollup))).values == legacy_rollup
        alert = await session.get(Alert, "old-alert")
        assert alert.component_id is None and alert.metric == "gpu.temp_c" and alert.resolved_at is None
        assert (await session.get(Preference, "thresholds")).value == {"gpu.temp_c": [70, 85]}
    await db.close()
    assert settings.key_file.read_bytes() == key_before
