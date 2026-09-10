import asyncio
import json
import os
import uuid
from urllib.parse import urlparse

import asyncpg
import asyncssh
import httpx
import pytest
from sqlalchemy.engine import make_url

from sparkscope.api import create_app
from sparkscope.config import Settings
from sparkscope.security import Vault
from sparkscope.ssh import Transport

SYSTEM = """---CPU_STAT---
cpu 100 0 100 700 0 0 0 0 0 0
---MEMINFO---
MemTotal: 134217728 kB
MemFree: 50000000 kB
MemAvailable: 80000000 kB
SwapTotal: 1000000 kB
SwapFree: 900000 kB
---LOADAVG---
0.3 0.2 0.1 1/300 99
---GPU---
40, 20, [N/A], [N/A], [N/A], 50, 60, 150, 1000, 1000
---THERMAL---
/sys/thermal/temp: 50000
---UPTIME---
10000 1
---TOPCPU---
1 operator 1.0 1.0 python
"""


class FakeConn:
    def close(self):
        pass

    async def wait_closed(self):
        pass

    def is_closed(self):
        return False


class FakeTransport(Transport):
    def __init__(self, vault):
        super().__init__(vault)
        key = asyncssh.generate_private_key("ssh-ed25519")
        self.public = key.export_public_key().decode().strip()
        self.fingerprint = key.get_fingerprint()
        self.sent = []
        self.delay = {}
        self.failure = False

    async def host_key(self, address, port):
        return {"public_key": self.public, "fingerprint": self.fingerprint}

    async def connect(self, identity, host_key):
        if host_key != self.public:
            raise asyncssh.HostKeyNotVerifiable("Mismatch")
        if identity.get("password") != "test-only-password":
            raise asyncssh.PermissionDenied("Invalid")
        return FakeConn()

    async def connection(self, device):
        return FakeConn()

    async def run_on(self, conn, command, timeout=30, stdin=None):
        if command.startswith("curl"):
            config = json.loads(stdin.splitlines()[0].split(" = ", 1)[1])
            url = urlparse(config)
            if url.port == 8000 and url.path == "/v1/models":
                out = json.dumps({"data": [{"id": "test-model", "max_model_len": 32768}]})
            elif url.port == 8000 and url.path == "/metrics":
                out = 'vllm:generation_tokens_total{model_name="test-model"} 100\nvllm:num_requests_running 2\n'
            else:
                return {"exit_code": 22, "stdout": "", "stderr": "", "timed_out": False}
        elif "---CPU_STAT---" in command:
            out = SYSTEM
        elif command.startswith("hostname;"):
            out = "test-host\n6.14-test\nUbuntu\nNVIDIA GB10\n"
        else:
            out = ""
        return {"exit_code": 0, "stdout": out, "stderr": "", "timed_out": False}

    async def run(self, device, command, timeout=30, stdin=None):
        self.sent.append((device.id, command, timeout))
        if "---CPU_STAT---" in command:
            return await self.run_on(FakeConn(), command)
        if "nvme smart" in command:
            return {
                "exit_code": 0,
                "stdout": '{"temperature": 313, "percent_used": 2}',
                "stderr": "",
                "timed_out": False,
            }
        return {
            "exit_code": 1 if self.failure else 0,
            "stdout": "test output",
            "stderr": "test failure" if self.failure else "",
            "timed_out": False,
            "duration_ms": 1,
        }

    async def system(self, device):
        await asyncio.sleep(self.delay.get(device.id, 0))
        metrics, procs, top = self.parsers._parse_output(device.id, SYSTEM)
        return {"metrics": {k: v for k, v in metrics.items() if v is not None}, "gpu_procs": procs, "top_procs": top}


@pytest.fixture(params=["sqlite", "postgres"] if os.getenv("SPARKSCOPE_TEST_POSTGRES_URL") else ["sqlite"])
async def env(tmp_path, request):
    settings = Settings(data_dir=tmp_path, origins=["http://testserver"], collector_enabled=False)
    pg_conn = None
    pg_database = None
    if request.param == "postgres":
        url = make_url(os.environ["SPARKSCOPE_TEST_POSTGRES_URL"])
        pg_conn = await asyncpg.connect(
            host=url.host, port=url.port, user=url.username, password=url.password, database=url.database
        )
        pg_database = "sparkscope_test_" + uuid.uuid4().hex
        await pg_conn.execute('CREATE DATABASE "' + pg_database + '"')
        settings.database_url = url.set(drivername="postgresql+asyncpg", database=pg_database).render_as_string(
            hide_password=False
        )
    transport = FakeTransport(Vault(settings.key_file))
    app = create_app(settings, transport)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://testserver", headers={"Origin": "http://testserver"}
        ) as client:
            setup = (tmp_path / "setup.secret").read_text().strip()
            result = await client.post(
                "/api/v1/auth/setup", json={"username": "admin", "password": "test-only-admin-password", "token": setup}
            )
            assert result.status_code == 200, result.text
            client.headers["X-CSRF-Token"] = result.json()["csrf"]
            yield app, client, transport
    if pg_conn:
        await pg_conn.execute('DROP DATABASE "' + pg_database + '"')
        await pg_conn.close()


async def wait_job(client, id, states=("complete", "failed", "awaiting_trust")):
    for _ in range(100):
        response = await client.get("/api/v1/jobs/" + id)
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in states:
            return job
        await asyncio.sleep(0.02)
    raise AssertionError(f"Job {id} did not finish")


async def onboard(client, name="Node 1", address="10.0.0.10"):
    r = await client.post(
        "/api/v1/discoveries",
        json={"address": address, "port": 22, "username": "operator", "password": "test-only-password"},
    )
    assert r.status_code == 202, r.text
    j = await wait_job(client, r.json()["id"])
    assert j["status"] == "awaiting_trust"
    r = await client.post(f"/api/v1/discoveries/{j['id']}/trust", json={"fingerprint": j["result"]["fingerprint"]})
    assert r.status_code == 202, r.text
    await wait_job(client, j["id"], ("complete", "failed"))
    r = await client.post("/api/v1/devices", json={"discovery_id": j["id"], "name": name})
    assert r.status_code == 201, r.text
    return r.json()
