"""Account views, hardware policy, operational diagnostics and notification configuration."""

import math
import re
import time
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import Field, field_validator, model_validator
from sqlalchemy import func, or_, select

from .config import DEFAULT_THRESHOLDS
from .models import (
    Audit,
    Device,
    FleetEvent,
    MaintenanceWindow,
    NotificationChannel,
    NotificationDelivery,
    Preference,
    SavedView,
)
from .schemas import Input


class ViewConfig(Input):
    summary_widgets: list[Literal["reporting", "incidents", "power", "clusters"]] = Field(
        default_factory=lambda: ["reporting", "incidents", "power", "clusters"], max_length=4
    )
    live_window_seconds: Literal[60, 180, 300] = 300
    search: str = Field(default="", max_length=200)
    group: str = Field(default="", max_length=100)
    cluster: str = Field(default="", max_length=100)
    view: Literal["devices", "clusters"] = "devices"
    tv: bool = False
    page_size: Literal[4, 6] = 6
    rotation_seconds: Literal[0, 10, 20, 30, 60] = 20
    device_ids: list[str] = Field(default_factory=list, max_length=50)
    metric_keys: list[str] = Field(default_factory=list, max_length=30)
    colors: dict[str, str] = Field(default_factory=dict, max_length=30)

    @field_validator("colors")
    @classmethod
    def valid_colors(cls, v):
        if any(not re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in v.values()):
            raise ValueError("Use six-digit hex colors")
        return v


class ViewInput(Input):
    name: str = Field(min_length=1, max_length=100)
    shared: bool = False
    config: ViewConfig


class ChannelInput(Input):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["webhook", "email"]
    enabled: bool = False
    config: dict = Field(default_factory=dict, max_length=20)
    secret: dict[str, str] | None = None


class WindowInput(Input):
    name: str = Field(min_length=1, max_length=100)
    start: float = Field(allow_inf_nan=False)
    end: float = Field(allow_inf_nan=False)
    device_ids: list[str] = Field(default_factory=list, max_length=50)
    group: str = Field(default="", max_length=100)
    cluster: str = Field(default="", max_length=100)

    @model_validator(mode="after")
    def interval(self):
        if self.end <= self.start or self.end - self.start > 31 * 86400:
            raise ValueError("Use an end after start, within 31 days")
        if not (self.device_ids or self.group or self.cluster):
            raise ValueError("Select devices, a group or a cluster")
        return self


def public(row, fields):
    return {key: getattr(row, key) for key in fields.split()}


def channel_public(row):
    return {**public(row, "id name kind enabled config"), "has_secret": bool(row.secret)}


def validate_channel(body, previous_secret):
    secret = {**previous_secret, **(body.secret or {})}
    cfg = dict(body.config)
    if "allow_insecure" in cfg and not isinstance(cfg["allow_insecure"], bool):
        raise HTTPException(422, "allow_insecure must be a boolean")
    if any(len(v) > 8192 or "\r" in v or "\n" in v for v in secret.values()):
        raise HTTPException(422, "Invalid channel secret")
    if body.kind == "webhook":
        raw_url = secret.get("url", "")
        try:
            url = urlsplit(raw_url)
            port = url.port
        except ValueError:
            raise HTTPException(422, "Supply a valid HTTP(S) endpoint") from None
        if port == 0 or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in raw_url):
            raise HTTPException(422, "Supply a valid HTTP(S) endpoint")
        if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.fragment:
            raise HTTPException(422, "Supply an HTTP(S) endpoint without embedded credentials or fragments")
        if url.scheme == "http" and not cfg.get("allow_insecure", False):
            raise HTTPException(422, "Plain HTTP requires explicit allow_insecure for a trusted test endpoint")
        cfg = {"endpoint_host": url.hostname, "allow_insecure": bool(cfg.get("allow_insecure", False))}
        secret = {k: v for k, v in secret.items() if k in ("url", "token")}
    else:
        required = ("host", "sender", "recipients")
        if any(k not in cfg for k in required):
            raise HTTPException(422, "SMTP host, sender and recipients are required")
        if not isinstance(cfg["recipients"], list) or not 1 <= len(cfg["recipients"]) <= 50:
            raise HTTPException(422, "Supply 1–50 recipients")
        values = [cfg["host"], cfg["sender"], *cfg["recipients"]]
        if any(not isinstance(v, str) or not v or len(v) > 253 or "\n" in v or "\r" in v for v in values):
            raise HTTPException(422, "Invalid SMTP address or host")
        if any(not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+", v) for v in [cfg["sender"], *cfg["recipients"]]):
            raise HTTPException(422, "Supply plain email addresses")
        tls = cfg.get("tls", "starttls")
        if tls not in ("ssl", "starttls", "none") or (tls == "none" and not cfg.get("allow_insecure", False)):
            raise HTTPException(422, "SMTP requires TLS; insecure test endpoints need explicit allow_insecure")
        port = cfg.get("port", 465 if tls == "ssl" else 587)
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise HTTPException(422, "Invalid SMTP port")
        cfg = {k: cfg[k] for k in required} | {
            "port": port,
            "tls": tls,
            "allow_insecure": bool(cfg.get("allow_insecure", False)),
        }
        secret = {k: v for k, v in secret.items() if k in ("username", "password")}
    return cfg, secret


def validate_hardware(body):
    if not isinstance(body, dict) or set(body) - {"profiles", "devices"}:
        raise HTTPException(422, "Supply profiles and devices")

    def rules(values):
        if not isinstance(values, dict) or len(values) > 50:
            raise HTTPException(422, "Invalid metric rules")
        for key, pair in values.items():
            if key not in DEFAULT_THRESHOLDS:
                raise HTTPException(422, "Unsupported threshold metric")
            if pair is None:
                continue
            if (
                not isinstance(pair, list)
                or len(pair) != 2
                or any(
                    v is not None
                    and (isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0)
                    for v in pair
                )
                or pair[0] is None
                or (pair[1] is not None and pair[1] < pair[0])
            ):
                raise HTTPException(422, "Invalid warning/critical pair")

    profiles = body.get("profiles", {})
    devices = body.get("devices", {})
    if not isinstance(profiles, dict) or not isinstance(devices, dict) or len(profiles) > 50 or len(devices) > 1000:
        raise HTTPException(422, "Invalid hardware policy")
    for name, profile in profiles.items():
        if not name.strip() or len(name) > 100 or not isinstance(profile, dict) or set(profile) - {"metrics"}:
            raise HTTPException(422, "Invalid profile")
        rules(profile.get("metrics", {}))
    for row in devices.values():
        if (
            not isinstance(row, dict)
            or set(row) - {"profile", "metrics", "gpus"}
            or row.get("profile", "") not in ("", *profiles)
        ):
            raise HTTPException(422, "Invalid device policy or profile")
        rules(row.get("metrics", {}))
        gpus = row.get("gpus", {})
        if not isinstance(gpus, dict) or len(gpus) > 64:
            raise HTTPException(422, "Invalid GPU rules")
        for gpu, gpu_rules in gpus.items():
            if not re.fullmatch(r"GPU-[a-zA-Z0-9-]{1,90}", gpu):
                raise HTTPException(422, "Use a discovered GPU UUID")
            rules(gpu_rules)
    return {"profiles": profiles, "devices": devices}


def install(app, db, vault, collector, notifier, current_user, role):
    async def audited(s, user, action, target=""):
        s.add(Audit(actor=user.username, action=action, target=target))

    @app.get("/api/v1/views")
    async def views(user=Depends(current_user)):
        async with db.session() as s:
            rows = (
                await s.scalars(
                    select(SavedView)
                    .where(or_(SavedView.owner_id == user.id, SavedView.shared.is_(True)))
                    .order_by(SavedView.name)
                )
            ).all()
            return [public(r, "id owner_id name shared config") for r in rows]

    @app.post("/api/v1/views")
    async def add_view(body: ViewInput, user=Depends(current_user)):
        if body.shared and user.role != "admin":
            raise HTTPException(403, "Only administrators manage shared views")
        async with db.session() as s:
            if await s.scalar(select(func.count()).select_from(SavedView).where(SavedView.owner_id == user.id)) >= 50:
                raise HTTPException(409, "Limit of 50 saved views reached")
            row = SavedView(owner_id=user.id, **body.model_dump())
            s.add(row)
            await s.flush()
            await audited(s, user, "view.create", row.id)
            return public(row, "id owner_id name shared config")

    async def owned_view(s, id, user):
        row = await s.get(SavedView, id)
        if not row or (not row.shared and row.owner_id != user.id):
            raise HTTPException(404, "View not found")
        if row.shared and user.role != "admin":
            raise HTTPException(403, "Only administrators manage shared views")
        return row

    @app.put("/api/v1/views/{id}")
    async def edit_view(id: str, body: ViewInput, user=Depends(current_user)):
        async with db.session() as s:
            row = await owned_view(s, id, user)
            if body.shared and user.role != "admin":
                raise HTTPException(403, "Only administrators manage shared views")
            # An admin cannot privatize somebody else's shared view under that owner's identity.
            if row.shared and not body.shared:
                row.owner_id = user.id
            for key, value in body.model_dump().items():
                setattr(row, key, value)
            await audited(s, user, "view.update", id)
            return public(row, "id owner_id name shared config")

    @app.delete("/api/v1/views/{id}")
    async def delete_view(id: str, user=Depends(current_user)):
        async with db.session() as s:
            await s.delete(await owned_view(s, id, user))
            await audited(s, user, "view.delete", id)
        return {"ok": True}

    @app.get("/api/v1/events")
    async def events(
        device_id: str | None = None,
        start: float = Query(0, ge=0, allow_inf_nan=False),
        end: float = Query(1e12, ge=0, allow_inf_nan=False),
        user=Depends(current_user),
    ):
        async with db.session() as s:
            query = select(FleetEvent).where(FleetEvent.ts >= start, FleetEvent.ts <= end)
            if device_id:
                query = query.where(FleetEvent.device_id == device_id)
            rows = (await s.scalars(query.order_by(FleetEvent.ts.desc()).limit(1000))).all()
            return [public(r, "id device_id component_id kind ts detail") for r in rows]

    @app.get("/api/v1/settings/hardware")
    async def hardware(user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(Preference, "hardware_rules")
            return row.value if row else {"profiles": {}, "devices": {}}

    @app.put("/api/v1/settings/hardware")
    async def update_hardware(body: dict, user=Depends(role("admin"))):
        value = validate_hardware(body)
        async with db.session() as s:
            await s.merge(Preference(key="hardware_rules", value=value))
            await audited(s, user, "hardware.rules")
        return value

    @app.get("/api/v1/devices/{id}/thresholds")
    async def effective(id: str, user=Depends(current_user)):
        from .hardware import effective_rules

        async with db.session() as s:
            device = await s.get(Device, id)
            if not device:
                raise HTTPException(404, "Device not found")
            global_rules = await s.get(Preference, "thresholds")
            overrides = await s.get(Preference, "hardware_rules")
            return effective_rules(
                id,
                (device.latest or {}).get("system", {}).get("metrics", {}),
                global_rules.value if global_rules else None,
                overrides.value if overrides else None,
            )

    @app.get("/api/v1/notification-channels")
    async def channels(user=Depends(role("admin"))):
        async with db.session() as s:
            return [channel_public(r) for r in (await s.scalars(select(NotificationChannel))).all()]

    async def save_channel(s, body, row, user):
        if row and row.kind != body.kind:
            raise HTTPException(422, "Create a new channel to change its type")
        cfg, secret = validate_channel(body, vault.open(row.secret) if row else {})
        cfg["enabled_since"] = (
            row.config.get("enabled_since", time.time()) if row and row.enabled and body.enabled else time.time()
        )
        if row is None:
            row = NotificationChannel()
            s.add(row)
        row.name, row.kind, row.enabled, row.config, row.secret = (
            body.name,
            body.kind,
            body.enabled,
            cfg,
            vault.seal(secret),
        )
        await s.flush()
        await audited(s, user, "notification.configure", row.id)
        return channel_public(row)

    @app.post("/api/v1/notification-channels")
    async def add_channel(body: ChannelInput, user=Depends(role("admin"))):
        async with db.session() as s:
            return await save_channel(s, body, None, user)

    @app.put("/api/v1/notification-channels/{id}")
    async def edit_channel(id: str, body: ChannelInput, user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(NotificationChannel, id)
            if not row:
                raise HTTPException(404, "Channel not found")
            return await save_channel(s, body, row, user)

    @app.delete("/api/v1/notification-channels/{id}")
    async def delete_channel(id: str, user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(NotificationChannel, id)
            if row:
                await s.delete(row)
                await audited(s, user, "notification.delete", id)
        return {"ok": True}

    @app.post("/api/v1/notification-channels/{id}/test")
    async def test_channel(id: str, user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(NotificationChannel, id)
            if not row or not row.enabled:
                raise HTTPException(409, "Enable this channel before explicitly sending a test")
            from .models import uid

            event_id = "test-" + uid()
            s.add(
                NotificationDelivery(
                    event_id=event_id, channel_id=id, payload={"event_id": event_id, "kind": "test", "ts": time.time()}
                )
            )
            await audited(s, user, "notification.test", id)
        return {"ok": True, "event_id": event_id}

    @app.get("/api/v1/notification-deliveries")
    async def deliveries(user=Depends(role("admin"))):
        async with db.session() as s:
            rows = (
                await s.scalars(
                    select(NotificationDelivery).order_by(NotificationDelivery.next_attempt.desc()).limit(100)
                )
            ).all()
            return [public(r, "id event_id channel_id status attempts next_attempt error") for r in rows]

    @app.get("/api/v1/maintenance-windows")
    async def windows(user=Depends(current_user)):
        async with db.session() as s:
            return [
                public(r, "id name scope start end summarized")
                for r in (
                    await s.scalars(select(MaintenanceWindow).order_by(MaintenanceWindow.start.desc()).limit(200))
                ).all()
            ]

    @app.post("/api/v1/maintenance-windows")
    async def add_window(body: WindowInput, user=Depends(role("admin"))):
        async with db.session() as s:
            row = MaintenanceWindow(
                name=body.name,
                start=body.start,
                end=body.end,
                scope={"device_ids": body.device_ids, "group": body.group, "cluster": body.cluster},
            )
            s.add(row)
            await s.flush()
            await audited(s, user, "maintenance.create", row.id)
            return public(row, "id name scope start end summarized")

    @app.delete("/api/v1/maintenance-windows/{id}")
    async def end_window(id: str, user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(MaintenanceWindow, id)
            if row:
                if row.start > time.time():
                    await s.delete(row)
                else:
                    row.end = min(row.end, time.time())
                await audited(s, user, "maintenance.end", id)
        return {"ok": True}

    async def diagnostics():
        now = time.time()
        database = True
        try:
            async with db.session() as s:
                await s.scalar(select(1))
                pending = await s.scalar(
                    select(func.count())
                    .select_from(NotificationDelivery)
                    .where(NotificationDelivery.status == "pending")
                )
        except Exception:
            database, pending = False, None
        enabled = app.state.settings.collector_enabled
        metrics = collector.metrics
        grace = now - app.state.started_at < 90
        supervising = not enabled or grace or now - (metrics.get("last_supervision") or 0) < 15
        maintenance = not enabled or grace or now - (metrics.get("last_maintenance") or 0) < 180
        notifications = not enabled or grace or now - (notifier.last_progress or 0) < 180
        stalled = []
        if enabled and not grace:
            for device_id, (_, tasks) in collector.tasks.items():
                for kind in ("system", "services", "smart", "discovery"):
                    progress = metrics.get("last_progress", {}).get(f"{device_id}:{kind}", app.state.started_at)
                    if now - progress > 180:
                        stalled.append({"device_id": device_id, "kind": kind})
        ready = database and supervising and maintenance and notifications and not stalled
        return {
            "ready": ready,
            "database": database,
            "collector_enabled": enabled,
            "stalled_jobs": stalled,
            "supervision": supervising,
            "maintenance": maintenance,
            "notifications": notifications,
            "pending_notifications": pending,
            "collector": metrics,
            "notification_error": notifier.last_error,
        }

    @app.get("/api/v1/readiness")
    async def readiness():
        result = await diagnostics()
        return JSONResponse({"ready": result["ready"]}, status_code=200 if result["ready"] else 503)

    @app.get("/api/v1/diagnostics")
    async def diagnostic_details(user=Depends(role("admin"))):
        return await diagnostics()
