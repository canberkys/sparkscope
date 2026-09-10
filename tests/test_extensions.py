import time
from contextlib import asynccontextmanager

import httpx
from conftest import onboard
from sqlalchemy import select

from sparkscope.models import Alert, FleetEvent, MaintenanceWindow, NotificationChannel, NotificationDelivery
from sparkscope.notifications import Notifier


@asynccontextmanager
async def viewer_client(app, admin):
    await admin.post(
        "/api/v1/users", json={"username": "viewer-extra", "password": "test-only-viewer-password", "role": "viewer"}
    )
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://testserver", headers={"Origin": "http://testserver"}
    )
    response = await client.post(
        "/api/v1/auth/login", json={"username": "viewer-extra", "password": "test-only-viewer-password"}
    )
    client.headers["X-CSRF-Token"] = response.json()["csrf"]
    try:
        yield client
    finally:
        await client.aclose()


async def test_saved_views_account_isolation_and_shared_admin(env):
    app, admin, _ = env
    private = (await admin.post("/api/v1/views", json={"name": "private", "config": {}})).json()
    shared = (
        await admin.post(
            "/api/v1/views", json={"name": "shared", "shared": True, "config": {"page_size": 4, "rotation_seconds": 30}}
        )
    ).json()
    async with viewer_client(app, admin) as viewer:
        rows = (await viewer.get("/api/v1/views")).json()
        assert [r["id"] for r in rows] == [shared["id"]]
        assert (
            await viewer.put("/api/v1/views/" + private["id"], json={"name": "stolen", "config": {}})
        ).status_code == 404
        assert (await viewer.delete("/api/v1/views/" + shared["id"])).status_code == 403
        assert (
            await viewer.post("/api/v1/views", json={"name": "bad", "shared": True, "config": {}})
        ).status_code == 403
        copy = await viewer.post("/api/v1/views", json={"name": "my copy", "config": shared["config"]})
        assert copy.status_code == 200
        assert (
            await viewer.put(
                "/api/v1/views/" + copy.json()["id"], json={"name": "my change", "config": {"rotation_seconds": 0}}
            )
        ).status_code == 200
        assert (await viewer.get("/api/v1/notification-channels")).status_code == 403
    assert (
        await admin.post("/api/v1/views", json={"name": "invalid", "config": {"page_size": 500}})
    ).status_code == 422
    assert (
        await admin.post("/api/v1/views", json={"name": "invalid", "config": {"colors": {"gpu": "url(x)"}}})
    ).status_code == 422


async def test_channel_secrets_enable_and_validation(env):
    app, client, _ = env
    body = {
        "name": "test",
        "kind": "webhook",
        "config": {},
        "secret": {"url": "https://example.invalid/secret-path?token=private", "token": "private-token"},
    }
    response = await client.post("/api/v1/notification-channels", json=body)
    assert response.status_code == 200, response.text
    assert "private" not in response.text and "secret-path" not in response.text
    row = response.json()
    assert not row["enabled"]
    assert (await client.post(f"/api/v1/notification-channels/{row['id']}/test")).status_code == 409
    async with app.state.db.session() as s:
        stored = await s.get(NotificationChannel, row["id"])
        assert "private-token" not in stored.secret
    response = await client.put(
        f"/api/v1/notification-channels/{row['id']}",
        json={"name": "test", "kind": "webhook", "enabled": True, "config": {}},
    )
    assert response.status_code == 200
    assert (await client.post(f"/api/v1/notification-channels/{row['id']}/test")).status_code == 200
    invalid = {**body, "secret": {"url": "file:///tmp/file"}}
    assert (await client.post("/api/v1/notification-channels", json=invalid)).status_code == 422
    invalid["secret"] = {"url": "http://localhost:8888"}
    invalid["config"] = {"allow_insecure": "false"}
    assert (await client.post("/api/v1/notification-channels", json=invalid)).status_code == 422
    assert (
        await client.post(
            "/api/v1/notification-channels",
            json={
                "name": "mail",
                "kind": "email",
                "config": {"host": "localhost", "sender": "a@b.test\nBcc: x@y.test", "recipients": ["a@b.test"]},
            },
        )
    ).status_code == 422


async def test_malformed_webhook_endpoints_are_rejected_without_exposing_secrets(env):
    _, client, _ = env
    for url in (
        "https://[broken/secret-path",
        "https://example.invalid:not-a-port/secret-path",
        "https://example.invalid:99999/secret-path",
        "https://example.invalid:0/secret-path",
        "https://exa mple.invalid/secret-path",
    ):
        response = await client.post(
            "/api/v1/notification-channels",
            json={"name": "invalid", "kind": "webhook", "secret": {"url": url}},
        )
        assert response.status_code == 422, response.text
        assert "secret-path" not in response.text
    assert (await client.get("/api/v1/notification-channels")).json() == []


async def test_notification_restart_dedup_late_event_and_retry_cap(env):
    app, client, transport = env
    device = await onboard(client)
    channel = (
        await client.post(
            "/api/v1/notification-channels",
            json={
                "name": "test",
                "kind": "webhook",
                "enabled": True,
                "config": {},
                "secret": {"url": "https://example.invalid"},
            },
        )
    ).json()
    attempts = []

    async def fail(c, secret, payload):
        attempts.append(payload["event_id"])
        raise RuntimeError("secret payload must not be exposed")

    notifier = Notifier(app.state.db, transport.vault, fail)
    ts = time.time()
    async with app.state.db.session() as s:
        s.add(FleetEvent(id="event-first", device_id=device["id"], kind="alarm.open", ts=ts))
    await notifier.tick()
    for _ in range(6):
        async with app.state.db.session() as s:
            for row in (await s.scalars(select(NotificationDelivery))).all():
                row.next_attempt = 0
        await Notifier(app.state.db, transport.vault, fail).tick()
    assert attempts == ["event-first"] * 5
    async with app.state.db.session() as s:
        rows = (await s.scalars(select(NotificationDelivery))).all()
        assert len(rows) == 1 and rows[0].status == "failed" and rows[0].attempts == 5
        assert "secret payload" not in rows[0].error
        # A late commit with an older timestamp cannot be skipped by an event cursor.
        c = await s.get(NotificationChannel, channel["id"])
        c.config = {**c.config, "enabled_since": ts - 100}
        s.add(FleetEvent(id="event-late", device_id=device["id"], kind="alarm.resolve", ts=ts - 1))
    await notifier.tick()
    assert attempts[-1] == "event-late"


async def test_maintenance_suppresses_events_and_pending_then_summarizes_once(env):
    app, client, transport = env
    device = await onboard(client)
    channel = (
        await client.post(
            "/api/v1/notification-channels",
            json={
                "name": "test",
                "kind": "webhook",
                "enabled": True,
                "config": {},
                "secret": {"url": "https://example.invalid"},
            },
        )
    ).json()
    sent = []

    async def deliver(c, secret, payload):
        sent.append(payload)

    now = time.time()
    window = (
        await client.post(
            "/api/v1/maintenance-windows",
            json={"name": "maintenance", "start": now - 10, "end": now + 60, "device_ids": [device["id"]]},
        )
    ).json()
    async with app.state.db.session() as s:
        s.add(
            Alert(id="alert-open", device_id=device["id"], metric="cpu.temp_max_c", severity="warning", message="hot")
        )
        s.add(FleetEvent(id="during", device_id=device["id"], kind="alarm.open", ts=now))
        s.add(
            NotificationDelivery(
                event_id="pending-before",
                channel_id=channel["id"],
                payload={"event_id": "pending-before", "kind": "alarm.open", "device_id": device["id"]},
            )
        )
    notifier = Notifier(app.state.db, transport.vault, deliver)
    await notifier.tick()
    assert not sent
    await client.delete("/api/v1/maintenance-windows/" + window["id"])
    await notifier.tick()
    await notifier.tick()
    assert len(sent) == 1 and sent[0]["kind"] == "maintenance.summary"
    async with app.state.db.session() as s:
        row = await s.get(MaintenanceWindow, window["id"])
        assert row.summarized
    assert (
        await client.post("/api/v1/maintenance-windows", json={"name": "bad", "start": now, "end": now + 60})
    ).status_code == 422


async def test_hardware_policy_validation_events_and_readiness(env):
    app, client, _ = env
    device = await onboard(client)
    config = {
        "profiles": {"H200 custom": {"metrics": {"gpu.power_draw_w": None}}},
        "devices": {device["id"]: {"profile": "H200 custom", "metrics": {"cpu.temp_max_c": [70, 85]}}},
    }
    assert (await client.put("/api/v1/settings/hardware", json=config)).status_code == 200
    assert (await client.get("/api/v1/settings/hardware")).json() == config
    bad = {"profiles": {"bad": {"metrics": {"gpu.temp_c": [90, 80]}}}}
    assert (await client.put("/api/v1/settings/hardware", json=bad)).status_code == 422
    assert (await client.get(f"/api/v1/devices/{device['id']}/thresholds")).status_code == 200
    assert (await client.get("/api/v1/readiness")).json() == {"ready": True}
    app.state.settings.collector_enabled = True
    app.state.started_at = time.time() - 200
    assert (await client.get("/api/v1/readiness")).status_code == 503
    # An offline device does not make healthy local scheduling unready.
    app.state.collector.metrics.update(last_supervision=time.time(), last_maintenance=time.time())
    app.state.notifier.last_progress = time.time()
    assert (await client.get("/api/v1/readiness")).status_code == 200
    assert (await client.get("/api/v1/events?start=nan")).status_code == 422
