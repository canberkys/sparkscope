import httpx
from conftest import onboard, wait_job


async def discover(client, device_id=None):
    body = {"address": "10.0.0.10", "username": "operator", "password": "test-only-password"}
    if device_id:
        body["device_id"] = device_id
    response = await client.post("/api/v1/discoveries", json=body)
    assert response.status_code == 202
    job = await wait_job(client, response.json()["id"])
    response = await client.post(
        f"/api/v1/discoveries/{job['id']}/trust", json={"fingerprint": job["result"]["fingerprint"]}
    )
    assert response.status_code == 202
    await wait_job(client, job["id"], ("complete", "failed"))
    return job["id"]


async def test_explicit_cluster_create_edit_clear_preserves_info_and_group(env):
    _, client, transport = env
    job_id = await discover(client)
    response = await client.post(
        "/api/v1/devices",
        json={"discovery_id": job_id, "name": "Node 1", "group": "Lab", "cluster_name": "  Inference A  "},
    )
    assert response.status_code == 201
    device = response.json()
    assert device["cluster_name"] == "Inference A" and device["group"] == "Lab"
    url = "/api/v1/devices/" + device["id"]
    initial = (await client.get(url)).json()["info"]
    sent = list(transport.sent)
    response = await client.patch(
        url, json={"name": "Node 1", "group": "Lab", "cluster_name": "Inference B", "cluster_peer_ip": "10.0.0.11"}
    )
    assert response.status_code == 200
    assert response.json()["cluster_name"] == "Inference B"
    response = await client.patch(url, json={"name": "Node 1", "group": "Production"})
    assert response.json()["cluster_name"] == "Inference B"
    assert response.json()["group"] == "Production"
    response = await client.patch(url, json={"name": "Node 1", "group": "Production", "cluster_name": "  "})
    assert response.json()["cluster_name"] == ""
    detail = (await client.get(url)).json()
    assert detail["info"]["cluster_peer_ip"] == "10.0.0.11"
    for key, value in initial.items():
        if key != "cluster_name":
            assert detail["info"][key] == value
    assert (await client.get("/api/v1/devices")).json()[0]["cluster_name"] == ""
    assert transport.sent == sent


async def test_cluster_defaults_independent_of_group_and_requires_admin(env):
    app, admin, _ = env
    device = await onboard(admin)
    assert device["cluster_name"] == ""
    url = "/api/v1/devices/" + device["id"]
    assert (
        await admin.post(
            "/api/v1/users", json={"username": "viewer", "password": "test-only-user-password", "role": "viewer"}
        )
    ).status_code == 201
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver") as viewer:
        login = await viewer.post(
            "/api/v1/auth/login", json={"username": "viewer", "password": "test-only-user-password"}
        )
        viewer.headers["X-CSRF-Token"] = login.json()["csrf"]
        assert (await viewer.get(url)).json()["cluster_name"] == ""
        assert (
            await viewer.patch(url, json={"name": "Node 1", "group": "Cluster-like group", "cluster_name": "A"})
        ).status_code == 403
        assert (
            await viewer.post("/api/v1/devices", json={"name": "Node 2", "discovery_id": "none", "cluster_name": "A"})
        ).status_code == 403
    response = await admin.patch(url, json={"name": "Node 1", "group": "Cluster-like group"})
    assert response.json()["cluster_name"] == ""
    assert (
        await admin.patch(url, json={"name": "Node 1", "group": "Lab", "cluster_name": "x" * 81})
    ).status_code == 422
    response = await admin.patch(url, json={"name": "Node 1", "group": "Lab", "cluster_name": "  " + "x" * 80 + "  "})
    assert response.status_code == 200
    assert response.json()["cluster_name"] == "x" * 80


async def test_connection_update_preserves_omitted_cluster_and_peer(env):
    _, client, _ = env
    device = await onboard(client)
    response = await client.patch(
        "/api/v1/devices/" + device["id"],
        json={"name": "Node 1", "group": "Lab", "cluster_name": "Inference", "cluster_peer_ip": "10.0.0.11"},
    )
    assert response.status_code == 200
    job_id = await discover(client, device["id"])
    response = await client.post("/api/v1/devices", json={"discovery_id": job_id, "name": "Node 1", "group": "Lab"})
    assert response.status_code == 201
    assert response.json()["cluster_name"] == "Inference"
    detail = (await client.get("/api/v1/devices/" + device["id"])).json()
    assert detail["info"]["cluster_peer_ip"] == "10.0.0.11"
