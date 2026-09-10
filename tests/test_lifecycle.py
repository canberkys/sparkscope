import sqlite3
import time

import pytest
from conftest import FakeTransport
from cryptography.fernet import Fernet, InvalidToken
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from sparkscope.api import create_app
from sparkscope.cli import import_legacy
from sparkscope.config import Settings
from sparkscope.models import Device, Sample
from sparkscope.security import Vault


async def test_legacy_import_preserves_identity_values_and_backup(env, tmp_path):
    app, _, _ = env
    config = tmp_path / "old.yaml"
    config.write_text(
        "hosts:\n  host1:\n    ssh_alias: host1\n    display_name: Old node\n    management_ip: 10.0.0.10\n"
    )
    old = tmp_path / "old.db"
    with sqlite3.connect(old) as s:
        s.execute("CREATE TABLE metrics(timestamp INTEGER,host TEXT,category TEXT,metric TEXT,value REAL)")
        s.execute("INSERT INTO metrics VALUES (?,?,?,?,?)", (int(time.time()) - 30, "host1", "gpu", "temp_c", 55))
    count = await import_legacy(app.state.db, app.state.vault, config, old, tmp_path / "backups")
    assert count == 1
    async with app.state.db.session() as s:
        d = await s.scalar(select(Device).where(Device.legacy_name == "host1"))
        assert d.paused and d.name == "Old node"
        sample = await s.scalar(select(Sample).where(Sample.device_id == d.id))
        assert sample.values["gpu.temp_c"] == 55
    assert list((tmp_path / "backups").glob("legacy-*.db"))
    with sqlite3.connect(old) as s:
        assert s.execute("SELECT COUNT(*) FROM metrics").fetchone()[0] == 1


def test_vault_restart_rotation_and_missing_wrong_key(tmp_path):
    path = tmp_path / "master.secret"
    vault = Vault(path)
    sealed = vault.seal({"password": "sensitive-test"})
    assert Vault(path).open(sealed)["password"] == "sensitive-test"
    old = path.read_text()
    path.write_text(Fernet.generate_key().decode() + "\n" + old)
    rotated = Vault(path).rotate(sealed)
    path.write_text(path.read_text().splitlines()[0])
    assert Vault(path).open(rotated)["password"] == "sensitive-test"
    with pytest.raises(InvalidToken):
        Vault(path).open(sealed)
    path.chmod(0o644)
    with pytest.raises(RuntimeError, match="permissions"):
        Vault(path)


def test_websocket_auth_origin_and_initial_snapshot(tmp_path):
    settings = Settings(data_dir=tmp_path, collector_enabled=False, origins=["http://testserver"])
    app = create_app(settings, FakeTransport(Vault(settings.key_file)))
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/v1/live", headers={"Origin": "http://testserver"}):
                pass
        r = client.post(
            "/api/v1/auth/setup",
            json={
                "username": "admin",
                "password": "test-only-admin-password",
                "token": (tmp_path / "setup.secret").read_text().strip(),
            },
        )
        assert r.status_code == 200
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/v1/live", headers={"Origin": "https://untrusted.invalid"}):
                pass
        with client.websocket_connect("/api/v1/live", headers={"Origin": "http://testserver"}) as ws:
            payload = ws.receive_json()
            assert payload["type"] == "snapshot"
            assert payload["devices"] == []
        client.headers["X-CSRF-Token"] = r.json()["csrf"]
        assert client.post("/api/v1/auth/logout").status_code == 200
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/v1/live", headers={"Origin": "http://testserver"}):
                pass


async def test_only_one_collector_can_own_database(env):
    from sparkscope.database import Database

    app, _, _ = env
    second = Database(app.state.settings.database_url)
    await app.state.db.acquire_collector()
    try:
        with pytest.raises(RuntimeError, match="Another SparkScope collector"):
            await second.acquire_collector()
    finally:
        await second.close()


async def test_concurrent_smart_and_system_keep_both_sources(env):
    import asyncio

    from conftest import onboard

    app, c, _ = env
    d = await onboard(c)
    async with app.state.db.session() as s:
        row = await s.get(Device, d["id"])
    await asyncio.gather(app.state.collector.poll_system(row), app.state.collector.poll_smart(row))
    async with app.state.db.session() as s:
        row = await s.get(Device, d["id"])
        assert row.latest["system"]["metrics"]["gpu.util_pct"] == 40
        assert row.latest["smart"]["metrics"]["nvme.temp_c"] > 0
