import httpx
from conftest import onboard, wait_job
from sqlalchemy import select

from sparkscope.models import Audit, Device, Job


async def test_onboarding_trust_save_and_secrets(env):
    app, client, transport = env
    d = await onboard(client)
    assert d["host_key_verified"]
    detail = (await client.get("/api/v1/devices/" + d["id"])).json()
    assert detail["services"][0]["provider"] == "vllm"
    assert detail["services"][0]["models"][0]["name"] == "test-model"
    assert "test-only-password" not in str(detail)
    async with app.state.db.session() as s:
        row = await s.get(Device, d["id"])
        assert row.secret and "test-only-password" not in row.secret
        assert app.state.vault.open(row.secret)["password"] == "test-only-password"
        assert all(not j.secret for j in (await s.scalars(select(Job))).all())
        assert "test-only-password" not in str([a.detail for a in (await s.scalars(select(Audit))).all()])


async def test_cannot_save_before_trust(env):
    _, client, _ = env
    r = await client.post(
        "/api/v1/discoveries", json={"address": "10.0.0.10", "username": "operator", "password": "test-only-password"}
    )
    j = await wait_job(client, r.json()["id"])
    assert (
        await client.post("/api/v1/devices", json={"discovery_id": j["id"], "name": "Untrusted"})
    ).status_code == 409
    assert (await client.post(f"/api/v1/discoveries/{j['id']}/trust", json={"fingerprint": "wrong"})).status_code == 409


async def test_auth_csrf_origin_and_roles(env):
    app, admin, _ = env
    assert (await admin.get("/api/v1/devices")).status_code == 200
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver") as c:
        assert (await c.get("/api/v1/devices")).status_code == 401
        assert (
            await c.post(
                "/api/v1/auth/login",
                headers={"Origin": "https://attacker.invalid"},
                json={"username": "admin", "password": "test-only-admin-password"},
            )
        ).status_code == 403
        for role in ("viewer", "operator"):
            r = await admin.post(
                "/api/v1/users", json={"username": role, "password": "test-only-user-password", "role": role}
            )
            assert r.status_code == 201, r.text
            login = await c.post("/api/v1/auth/login", json={"username": role, "password": "test-only-user-password"})
            c.headers["X-CSRF-Token"] = login.json()["csrf"]
            assert (await c.get("/api/v1/devices")).status_code == 200
            assert (
                await c.post("/api/v1/discoveries", json={"address": "10.0.0.10", "username": "operator"})
            ).status_code == 403
            assert (await c.get("/api/v1/users")).status_code == 403
            assert (
                await c.post("/api/v1/operations", json={"command": "reboot", "device_ids": ["test"]})
            ).status_code == 403
    bad = await admin.post(
        "/api/v1/users",
        headers={"X-CSRF-Token": "wrong"},
        json={"username": "bad", "password": "test-only-user-password", "role": "viewer"},
    )
    assert bad.status_code == 403


async def test_operation_confirmation_binds_targets_is_single_use_and_failure(env):
    _, c, t = env
    d = await onboard(c)
    other = await onboard(c, "Node 2", "10.0.0.11")
    body = {"command": "reboot", "device_ids": [d["id"]]}
    assert (await c.post("/api/v1/operations", json=body)).status_code == 403
    proof = (await c.post("/api/v1/operations/confirmations", json=body)).json()["confirmation"]
    assert (
        await c.post("/api/v1/operations", json={**body, "device_ids": [other["id"]], "confirmation": proof})
    ).status_code == 403
    t.failure = True
    r = await c.post("/api/v1/operations", json={**body, "confirmation": proof})
    assert r.status_code == 202, r.text
    j = await wait_job(c, r.json()["id"], ("complete", "failed"))
    assert j["status"] == "failed"
    assert j["result"][d["id"]]["exit_code"] == 1
    assert (await c.post("/api/v1/operations", json={**body, "confirmation": proof})).status_code == 403
    t.failure = False
    proof = (
        await c.post("/api/v1/operations/confirmations", json={"command": "apt_upgrade", "device_ids": [d["id"]]})
    ).json()["confirmation"]
    j = (
        await c.post(
            "/api/v1/operations", json={"command": "apt_upgrade", "device_ids": [d["id"]], "confirmation": proof}
        )
    ).json()
    await wait_job(c, j["id"], ("complete", "failed"))
    assert t.sent[-1][2] == 1800


async def test_device_lifecycle_and_validation_redacts_input(env):
    app, c, _ = env
    d = await onboard(c)
    changed = await c.patch(
        "/api/v1/devices/" + d["id"],
        json={"name": "Renamed", "group": "Research", "tags": ["lab"], "paused": True, "archived": True},
    )
    assert changed.status_code == 200
    assert not (await c.get("/api/v1/devices")).json()
    assert (await c.get("/api/v1/devices?archived=true")).json()[0]["id"] == d["id"]
    response = await c.post(
        "/api/v1/discoveries",
        json={"address": "http://bad/path", "username": "operator", "password": "SECRET-DO-NOT-ECHO"},
    )
    assert response.status_code == 422 and "SECRET-DO-NOT-ECHO" not in response.text
    users = (await c.get("/api/v1/users")).json()
    assert (
        await c.patch("/api/v1/users/" + users[0]["id"], json={"role": "viewer", "active": True})
    ).status_code == 409
