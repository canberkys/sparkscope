import asyncio
import logging
import random
import time

from sqlalchemy import select

from .alerts import AlertEngine
from .hardware import merge_inventory
from .history import maintain
from .models import Device, FleetEvent, Job, Preference, Sample, Service
from .runtimes import collect_service, discover
from .ssh import safe_error

log = logging.getLogger("sparkscope.collector")


class Collector:
    def __init__(self, db, transport, settings):
        self.db = db
        self.transport = transport
        self.settings = settings
        self.alerts = AlertEngine()
        self.tasks = {}
        self.state_locks = {}
        # Independent pools prevent a slow path occupying all system poll capacity.
        total = max(3, settings.concurrency)
        slow = max(1, total // 5)
        services = max(1, total * 3 // 10)
        self.capacities = {"system": total - slow - services, "services": services, "slow": slow}
        self.pools = {key: asyncio.Semaphore(size) for key, size in self.capacities.items()}
        self.stopping = False
        self.root = None
        self.maintenance = None
        self.metrics = {
            "polls": 0,
            "failures": 0,
            "last_maintenance": None,
            "last_supervision": None,
            "last_progress": {},
            "capacities": self.capacities,
        }

    async def start(self):
        # A restart never silently retries remote mutations.
        async with self.db.session() as s:
            for job in (await s.scalars(select(Job).where(Job.status.in_(["queued", "running"])))).all():
                job.status = "interrupted"
                job.secret = ""
                job.result = {**job.result, "error": "Application restarted. Verify remote state before retrying."}
        self.root = asyncio.create_task(self.supervise())
        self.maintenance = asyncio.create_task(self.maintain_loop())

    async def stop(self):
        self.stopping = True
        jobs = [t for pair in self.tasks.values() for t in pair[1]] + [t for t in (self.root, self.maintenance) if t]
        for task in jobs:
            task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        await self.transport.close_all()

    async def supervise(self):
        while not self.stopping:
            try:
                async with self.db.session() as s:
                    devices = (
                        await s.scalars(select(Device).where(Device.archived.is_(False), Device.paused.is_(False)))
                    ).all()
                self.metrics["last_supervision"] = time.time()
                desired = {d.id: d for d in devices}
                for key, (revision, tasks) in list(self.tasks.items()):
                    if key not in desired or desired[key].revision != revision or any(task.done() for task in tasks):
                        for task in tasks:
                            task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                        await self.transport.close(key)
                        self.alerts.reset(key)
                        del self.tasks[key]
                for d in devices:
                    if d.id not in self.tasks:
                        self.tasks[d.id] = (
                            d.revision,
                            [
                                asyncio.create_task(self.loop(d, kind))
                                for kind in ("system", "smart", "services", "discovery")
                            ],
                        )
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Collector supervision failed")
            await asyncio.sleep(1)

    async def loop(self, device, kind):
        failures = 0
        await asyncio.sleep(random.uniform(0, 0.5 if kind == "system" else 3))
        while True:
            started = time.monotonic()
            interval = self.settings.poll_seconds if kind in ("system", "services") else 60
            try:
                async with self.pools[kind if kind in ("system", "services") else "slow"]:
                    if kind == "system":
                        await self.poll_system(device)
                    elif kind == "smart":
                        await self.poll_smart(device)
                    elif kind == "discovery":
                        await self.discover_services(device)
                    else:
                        await self.poll_services(device)
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures += 1
                if kind == "system":
                    self.metrics["failures"] += 1
                    self.alerts.reset(device.id)
                    async with self.db.session() as s:
                        d = await s.get(Device, device.id)
                        if d and d.revision == device.revision:
                            if d.status != "offline":
                                s.add(
                                    FleetEvent(
                                        device_id=d.id,
                                        kind="connection.changed",
                                        ts=time.time(),
                                        detail={"from": d.status, "to": "offline"},
                                    )
                                )
                            d.status = "offline"
                            d.error = safe_error(exc)
                    await self.transport.close(device.id)
                # Failed slow paths do not erase a successful system sample.
                interval = min(60, 2 ** min(failures, 6))
            self.metrics["last_progress"][f"{device.id}:{kind}"] = time.time()
            await asyncio.sleep(max(0.1, interval - (time.monotonic() - started)))

    async def poll_system(self, device):
        result = await self.transport.system(device)
        ts = time.time()
        async with self.state_locks.setdefault(device.id, asyncio.Lock()):
            async with self.db.session() as s:
                d = await s.get(Device, device.id)
                if not d or d.revision != device.revision or d.paused or d.archived:
                    return
                latest = dict(d.latest or {})
                latest["system"] = {**result, "ts": ts}
                d.latest = latest
                d.last_seen = ts
                status = "online"
                gpu_state = (d.info or {}).get("capability_status", {}).get("gpu")
                if gpu_state == "unavailable" or (
                    (gpu_state == "available" or (d.info or {}).get("capabilities", {}).get("gpu"))
                    and not any(key.startswith("gpu.") for key in result["metrics"])
                ):
                    status = "degraded"
                if d.status != status:
                    s.add(
                        FleetEvent(
                            device_id=d.id, kind="connection.changed", ts=ts, detail={"from": d.status, "to": status}
                        )
                    )
                d.status = status
                d.error = None
                s.add(Sample(device_id=d.id, source="system", ts=ts, values=result["metrics"]))
                rules = await s.get(Preference, "thresholds")
                hardware_rules = await s.get(Preference, "hardware_rules")
                await self.alerts.evaluate(
                    s,
                    d.id,
                    result["metrics"],
                    ts,
                    rules.value if rules else None,
                    hardware_rules.value if hardware_rules else None,
                )
            self.metrics["polls"] += 1

    async def poll_smart(self, device):
        metrics = await self.transport.smart(device)
        ts = time.time()
        async with self.state_locks.setdefault(device.id, asyncio.Lock()):
            async with self.db.session() as s:
                d = await s.get(Device, device.id)
                if not d or d.revision != device.revision:
                    return
                latest = dict(d.latest or {})
                if metrics:
                    latest["smart"] = {"metrics": metrics, "ts": ts, "available": True}
                    s.add(Sample(device_id=d.id, source="smart", ts=ts, values=metrics))
                else:
                    latest["smart"] = {
                        **latest.get("smart", {}),
                        "available": False,
                        "error": "NVMe SMART unavailable. nvme-cli and non-interactive permission may be required.",
                    }
                d.latest = latest

    async def discover_services(self, device):
        conn = await self.transport.connection(device)
        try:
            info = await self.transport.info_on(conn)
        except Exception as exc:
            info = {
                "capability_status": {"system": "available", "gpu": "unavailable"},
                "hardware_checked_at": time.time(),
                "hardware_error": safe_error(exc),
            }
        async with self.state_locks.setdefault(device.id, asyncio.Lock()):
            async with self.db.session() as s:
                d = await s.get(Device, device.id)
                if not d or d.revision != device.revision:
                    return
                d.info = merge_inventory(d.info or {}, info)
                device.info = d.info
        found = await discover(self.transport, conn)
        async with self.db.session() as s:
            d = await s.get(Device, device.id)
            if not d or d.revision != device.revision:
                return
            existing = {
                (v.port, v.path): v
                for v in (await s.scalars(select(Service).where(Service.device_id == device.id))).all()
            }
            for item in found:
                if (item["port"], item["path"]) not in existing:
                    s.add(
                        Service(
                            device_id=device.id,
                            provider=item["provider"],
                            port=item["port"],
                            path=item["path"],
                            data=item["data"],
                            last_seen=time.time(),
                        )
                    )

    async def poll_services(self, device):
        async with self.db.session() as s:
            services = (await s.scalars(select(Service).where(Service.device_id == device.id))).all()
        if not services:
            return
        conn = await self.transport.connection(device)
        for service in services:
            key = self.transport.vault.open(service.secret).get("api_key", "")
            data = await collect_service(
                self.transport, conn, service.provider, service.port, service.path, key, service.data
            )
            async with self.db.session() as s:
                row = await s.get(Service, service.id)
                if not row:
                    continue
                old_status = (row.data or {}).get("status")
                if old_status != data.get("status"):
                    s.add(
                        FleetEvent(
                            device_id=device.id,
                            kind="service.changed",
                            ts=time.time(),
                            detail={
                                "service_id": row.id,
                                "provider": row.provider,
                                "from": old_status,
                                "to": data.get("status"),
                            },
                        )
                    )
                row.data = data
                if data["status"] == "online":
                    row.last_seen = time.time()
                    if data["metrics"]:
                        s.add(Sample(device_id=device.id, source=service.id, ts=row.last_seen, values=data["metrics"]))

    async def maintain_loop(self):
        while True:
            try:
                await maintain(self.db)
                self.metrics["last_maintenance"] = time.time()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Retention or rollup failed")
            await asyncio.sleep(60)
