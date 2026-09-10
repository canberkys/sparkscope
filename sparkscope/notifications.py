"""Durable, bounded alert delivery. No channel sends until explicitly enabled."""

import asyncio
import json
import smtplib
import ssl
import time
from email.message import EmailMessage

import httpx
from sqlalchemy import select

from .models import Alert, Device, FleetEvent, MaintenanceWindow, NotificationChannel, NotificationDelivery


def matches(scope, device):
    if not device:
        return False
    return (
        (not scope.get("device_ids") or device.id in scope["device_ids"])
        and (not scope.get("group") or device.group == scope["group"])
        and (not scope.get("cluster") or (device.info or {}).get("cluster_name") == scope["cluster"])
    )


async def send(channel, secret, payload):
    if channel.kind == "webhook":
        headers = {"X-SparkScope-Event-ID": payload["event_id"]}
        if secret.get("token"):
            headers["Authorization"] = "Bearer " + secret["token"]
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
            response = await client.post(secret["url"], json=payload, headers=headers)
            response.raise_for_status()
        return

    def smtp():
        cfg = channel.config
        message = EmailMessage()
        message["From"] = cfg["sender"]
        message["To"] = ", ".join(cfg["recipients"])
        message["Subject"] = "SparkScope · " + payload["kind"]
        message["Message-ID"] = f"<{payload['event_id']}.{channel.id}@sparkscope.local>"
        message.set_content(json.dumps(payload, indent=2))
        context = ssl.create_default_context()
        if cfg.get("tls", "starttls") == "ssl":
            server = smtplib.SMTP_SSL(cfg["host"], cfg.get("port", 465), timeout=10, context=context)
        else:
            server = smtplib.SMTP(cfg["host"], cfg.get("port", 587), timeout=10)
        with server:
            if cfg.get("tls", "starttls") == "starttls":
                server.starttls(context=context)
            if secret.get("username"):
                server.login(secret["username"], secret.get("password", ""))
            server.send_message(message)

    await asyncio.to_thread(smtp)


class Notifier:
    def __init__(self, db, vault, sender=send):
        self.db, self.vault, self.sender = db, vault, sender
        self.last_progress = None
        self.last_error = None

    async def enqueue(self, s, event_id, payload, channels):
        for channel in channels:
            exists = await s.scalar(
                select(NotificationDelivery.id).where(
                    NotificationDelivery.event_id == event_id, NotificationDelivery.channel_id == channel.id
                )
            )
            if not exists:
                s.add(NotificationDelivery(event_id=event_id, channel_id=channel.id, payload=payload, next_attempt=0))

    async def tick(self):
        now = time.time()
        async with self.db.session() as s:
            channels = (await s.scalars(select(NotificationChannel).where(NotificationChannel.enabled.is_(True)))).all()
            windows = (await s.scalars(select(MaintenanceWindow))).all()
            events = (
                await s.scalars(
                    select(FleetEvent)
                    .where(FleetEvent.notification_processed.is_(False))
                    .order_by(FleetEvent.ts, FleetEvent.id)
                    .limit(200)
                )
            ).all()
            for event in events:
                event.notification_processed = True
                if event.kind not in ("alarm.open", "alarm.escalate", "alarm.resolve"):
                    continue
                device = await s.get(Device, event.device_id)
                if any(w.start <= event.ts < w.end and matches(w.scope, device) for w in windows):
                    continue
                payload = {
                    "event_id": event.id,
                    "kind": event.kind,
                    "ts": event.ts,
                    "device_id": event.device_id,
                    "component_id": event.component_id,
                    "detail": event.detail,
                }
                await self.enqueue(
                    s, event.id, payload, [c for c in channels if event.ts >= c.config.get("enabled_since", now)]
                )
            for window in windows:
                if window.end > now or window.summarized:
                    continue
                alerts = (await s.scalars(select(Alert).where(Alert.resolved_at.is_(None)))).all()
                outstanding = []
                for alert in alerts:
                    device = await s.get(Device, alert.device_id)
                    if matches(window.scope, device) and not any(
                        w.start <= now < w.end and matches(w.scope, device) for w in windows
                    ):
                        outstanding.append(
                            {
                                "id": alert.id,
                                "device_id": alert.device_id,
                                "metric": alert.metric,
                                "severity": alert.severity,
                            }
                        )
                if outstanding:
                    event_id = "maintenance-" + window.id
                    await self.enqueue(
                        s,
                        event_id,
                        {"event_id": event_id, "kind": "maintenance.summary", "ts": now, "alerts": outstanding},
                        channels,
                    )
                window.summarized = True
        async with self.db.session() as s:
            due = (
                await s.scalars(
                    select(NotificationDelivery)
                    .where(NotificationDelivery.status == "pending", NotificationDelivery.next_attempt <= now)
                    .order_by(NotificationDelivery.next_attempt)
                    .limit(10)
                )
            ).all()
        for delivery in due:
            async with self.db.session() as s:
                row = await s.get(NotificationDelivery, delivery.id)
                channel = await s.get(NotificationChannel, row.channel_id)
                if not channel or not channel.enabled:
                    row.status = "cancelled"
                    continue
                if row.attempts >= 5:
                    row.status = "failed"
                    continue
                device = await s.get(Device, row.payload.get("device_id", ""))
                active_windows = (
                    await s.scalars(
                        select(MaintenanceWindow).where(MaintenanceWindow.start <= now, MaintenanceWindow.end > now)
                    )
                ).all()
                if device and any(matches(w.scope, device) for w in active_windows):
                    row.status = "suppressed"
                    continue
                # Commit attempt before I/O; restart may retry with the same event ID.
                row.attempts += 1
                row.next_attempt = now + 60
            error = None
            try:
                await self.sender(channel, self.vault.open(channel.secret), delivery.payload)
            except Exception:
                error = "Delivery failed; verify endpoint, TLS and credentials."
            async with self.db.session() as s:
                row = await s.get(NotificationDelivery, delivery.id)
                row.error = error
                row.status = "sent" if error is None else "failed" if row.attempts >= 5 else "pending"
                row.next_attempt = time.time() + min(900, 30 * 2 ** max(0, row.attempts - 1))
        self.last_progress = time.time()
        self.last_error = None

    async def run(self):
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                self.last_error = "Notification queue could not progress."
            await asyncio.sleep(5)
