"""Synthetic end-to-end collector/API/WebSocket load; never contacts a GB10."""

import argparse
import asyncio
import json
import math
import resource
import secrets
import tempfile
import time
from pathlib import Path

import httpx
import uvicorn
import websockets

from .api import create_app
from .config import Settings
from .models import Device, Service
from .security import Vault
from .ssh import Transport


class SyntheticConnection:
    def close(self):
        pass

    async def wait_closed(self):
        pass

    def is_closed(self):
        return False


class SyntheticTransport(Transport):
    async def connection(self, device):
        return SyntheticConnection()

    async def system(self, device):
        number = int(device.name.split("-")[-1])
        if number % 10 == 0:
            await asyncio.sleep(1)
            raise TimeoutError()
        await asyncio.sleep(0.01)
        wave = (math.sin(time.time() / 20 + number) + 1) / 2
        metrics = {
            "cpu.usage_pct": wave * 80,
            "cpu.temp_max_c": 50,
            "gpu.util_pct": wave * 90,
            "gpu.temp_c": 60,
            "gpu.power_draw_w": wave * 100,
            "gpu.ecc_uncorrected": 0,
            "gpu.throttle_active": 0,
            "memory.total_kb": 134217728,
            "memory.available_kb": 80000000,
            "memory.used_pct": 40,
            "disk.root_used_pct": 30,
            "disk.read_mbps": wave * 20,
            "disk.write_mbps": wave * 10,
        }
        metrics.update({f"network.eth{i}_{direction}_mbps": wave * 50 for i in range(10) for direction in ("rx", "tx")})
        metrics.update({f"synthetic.metric_{i}": wave * i for i in range(37)})
        return {"metrics": metrics, "gpu_procs": [], "top_procs": []}

    async def smart(self, device):
        return {"nvme.temp_c": 40, "nvme.used_pct": 2}

    async def run_on(self, conn, command, timeout=30, stdin=None):
        await asyncio.sleep(0.002)
        if stdin and "/v1/models" in stdin:
            out = json.dumps({"data": [{"id": "synthetic-model"}]})
            code = 0
        elif stdin and "/metrics" in stdin:
            out = f"vllm:generation_tokens_total {int(time.time() * 40)}\nvllm:num_requests_running 2\n"
            code = 0
        else:
            out = ""
            code = 22
        return {"stdout": out, "stderr": "", "exit_code": code, "timed_out": False}


def p95(values):
    return round(sorted(values)[max(0, math.ceil(len(values) * 0.95) - 1)], 4) if values else None


async def run(args):
    with tempfile.TemporaryDirectory(prefix="sparkscope-load-") as directory:
        settings = Settings(
            data_dir=Path(directory), database_url=args.database_url or "", origins=[f"http://127.0.0.1:{args.port}"]
        )
        transport = SyntheticTransport(Vault(settings.key_file))
        app = create_app(settings, transport)
        await app.state.db.migrate()
        async with app.state.db.session() as s:
            # External URL must identify a dedicated, empty load-test database.
            from sqlalchemy import func, select

            if await s.scalar(select(func.count()).select_from(Device)):
                raise RuntimeError("Load-test database must contain no devices")
            for n in range(args.devices):
                d = Device(
                    name=f"Load-{n + 1}",
                    address=f"192.0.2.{n + 1}",
                    username="synthetic",
                    group="Load test",
                    host_key="synthetic",
                    secret=app.state.vault.seal({"synthetic": True}),
                )
                s.add(d)
                await s.flush()
                s.add(Service(device_id=d.id, provider="vllm", port=8000, path=""))
        server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="error", access_log=False)
        )
        serving = asyncio.create_task(server.serve())
        while not server.started:
            if serving.done():
                await serving
                raise RuntimeError("Load-test server failed to start")
            await asyncio.sleep(0.05)
        latencies = []
        query_times = []
        errors = []
        messages = 0
        max_payload = 0
        start = time.monotonic()
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{args.port}") as client:
            response = await client.post(
                "/api/v1/auth/setup",
                json={
                    "username": "load-admin",
                    "password": secrets.token_urlsafe(24),
                    "token": (Path(directory) / "setup.secret").read_text().strip(),
                },
            )
            response.raise_for_status()
            cookie = client.cookies.get("sparkscope_session")

            async def viewer():
                nonlocal messages, max_payload
                try:
                    async with websockets.connect(
                        f"ws://127.0.0.1:{args.port}/api/v1/live",
                        origin=settings.origins[0],
                        additional_headers={"Cookie": f"sparkscope_session={cookie}"},
                    ) as ws:
                        async for raw in ws:
                            messages += 1
                            max_payload = max(max_payload, len(raw))
                            message = json.loads(raw)
                            if time.monotonic() - start > 5:
                                latencies.extend(
                                    time.time() - d["last_seen"]
                                    for d in message["devices"]
                                    if d.get("last_seen") and not d["stale"] and d["status"] != "offline"
                                )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    errors.append(type(exc).__name__)

            async def queries():
                while True:
                    t = time.monotonic()
                    try:
                        r = await client.get("/api/v1/devices")
                        r.raise_for_status()
                        query_times.append(time.monotonic() - t)
                    except Exception as exc:
                        errors.append(type(exc).__name__)
                    await asyncio.sleep(1)

            viewers = [asyncio.create_task(viewer()) for _ in range(args.clients)]
            pollers = [asyncio.create_task(queries()) for _ in range(args.clients)]
            while time.monotonic() - start < args.duration:
                await asyncio.sleep(min(10, max(0.1, args.duration - (time.monotonic() - start))))
                print(
                    json.dumps(
                        {
                            "elapsed_s": round(time.monotonic() - start),
                            "polls": app.state.collector.metrics["polls"],
                            "messages": messages,
                        }
                    ),
                    flush=True,
                )
            for task in viewers + pollers:
                task.cancel()
            await asyncio.gather(*(viewers + pollers), return_exceptions=True)
        server.should_exit = True
        await serving
        import sys

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024)
        report = {
            "synthetic_only": True,
            "devices": args.devices,
            "clients": args.clients,
            "duration_s": round(time.monotonic() - start, 2),
            "expected_offline_devices": args.devices // 10,
            "samples_collected": app.state.collector.metrics["polls"],
            "expected_connection_failures": app.state.collector.metrics["failures"],
            "websocket_messages": messages,
            "latency_p95_s": p95(latencies),
            "query_p95_s": p95(query_times),
            "max_payload_bytes": max_payload,
            "peak_rss_mb": round(rss, 1),
            "errors": errors,
            "full_24h_gate": args.duration >= 86400,
        }
        report["passed"] = bool(not errors and latencies and p95(latencies) <= 10 and p95(query_times) <= 1)
        if args.output:
            Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--duration", type=float, default=60)
    p.add_argument("--devices", type=int, choices=range(1, 51), default=50)
    p.add_argument("--clients", type=int, default=5)
    p.add_argument("--port", type=int, default=8011)
    p.add_argument("--database-url", help="Dedicated empty test database only; test records remain afterwards.")
    p.add_argument("--output")
    args = p.parse_args()
    if args.clients < 1 or args.duration < 10:
        p.error("Use at least one client and a duration of at least 10 seconds")
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
