import time
import uuid

from sqlalchemy import JSON, Boolean, Float, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def uid():
    return str(uuid.uuid4())


def now():
    return time.time()


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    address: Mapped[str] = mapped_column(String(253))
    port: Mapped[int] = mapped_column(default=22)
    username: Mapped[str] = mapped_column(String(100))
    group: Mapped[str] = mapped_column(String(100), default="Default")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    secret: Mapped[str] = mapped_column(Text, default="")
    host_key: Mapped[str] = mapped_column(Text, default="")
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    info: Mapped[dict] = mapped_column(JSON, default=dict)
    latest: Mapped[dict] = mapped_column(JSON, default=dict)
    last_seen: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="offline")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    legacy_name: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    created_at: Mapped[float] = mapped_column(Float, default=now)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    __table_args__ = (UniqueConstraint("address", "port", "username", name="uq_device_endpoint"),)


class Service(Base):
    __tablename__ = "services"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    device_id: Mapped[str] = mapped_column(String(36), index=True)
    provider: Mapped[str] = mapped_column(String(30))
    port: Mapped[int] = mapped_column(Integer)
    path: Mapped[str] = mapped_column(String(100), default="")
    manual: Mapped[bool] = mapped_column(Boolean, default=False)
    secret: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    last_seen: Mapped[float | None] = mapped_column(Float, nullable=True)
    __table_args__ = (UniqueConstraint("device_id", "port", "path", name="uq_service_endpoint"),)


class Sample(Base):
    __tablename__ = "samples"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(String(36))
    source: Mapped[str] = mapped_column(String(60), default="system")
    ts: Mapped[float] = mapped_column(Float)
    values: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (Index("ix_sample_lookup", "device_id", "ts"), Index("ix_sample_retention", "ts"))


class Rollup(Base):
    __tablename__ = "rollups"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(String(36))
    source: Mapped[str] = mapped_column(String(60))
    resolution: Mapped[int] = mapped_column(Integer)
    ts: Mapped[int] = mapped_column(Integer)
    values: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (
        UniqueConstraint("device_id", "source", "resolution", "ts", name="uq_rollup_bucket"),
        Index("ix_rollup_lookup", "device_id", "resolution", "ts"),
    )


class Alert(Base):
    component_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    __tablename__ = "fleet_alerts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    device_id: Mapped[str] = mapped_column(String(36), index=True)
    metric: Mapped[str] = mapped_column(String(100))
    severity: Mapped[str] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(Text)
    first_seen: Mapped[float] = mapped_column(Float, default=now)
    last_seen: Mapped[float] = mapped_column(Float, default=now)
    acknowledged_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    acknowledged_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    resolved_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    occurrences: Mapped[int] = mapped_column(Integer, default=1)
    __table_args__ = (Index("ix_alert_state", "device_id", "metric", "resolved_at"),)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    username: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(20))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    csrf: Mapped[str] = mapped_column(String(64))
    expires: Mapped[float] = mapped_column(Float)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    kind: Mapped[str] = mapped_column(String(30))
    owner_id: Mapped[str] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(30), default="queued")
    created_at: Mapped[float] = mapped_column(Float, default=now)
    updated_at: Mapped[float] = mapped_column(Float, default=now)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    secret: Mapped[str] = mapped_column(Text, default="")


class Confirmation(Base):
    __tablename__ = "confirmations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36))
    command: Mapped[str] = mapped_column(String(100))
    device_ids: Mapped[list] = mapped_column(JSON)
    expires: Mapped[float] = mapped_column(Float)


class Audit(Base):
    __tablename__ = "audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[float] = mapped_column(Float, default=now, index=True)
    actor: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(100))
    target: Mapped[str] = mapped_column(String(100), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


class Preference(Base):
    __tablename__ = "preferences"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class FleetEvent(Base):
    notification_processed: Mapped[bool] = mapped_column(Boolean, default=False)
    __tablename__ = "fleet_events"
    __table_args__ = (Index("ix_fleet_events_pending", "notification_processed", "ts", "id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    device_id: Mapped[str] = mapped_column(String(36), index=True)
    component_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    kind: Mapped[str] = mapped_column(String(40))
    ts: Mapped[float] = mapped_column(Float, default=now, index=True)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


class SavedView(Base):
    __tablename__ = "saved_views"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(100))
    shared: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict)


class NotificationChannel(Base):
    __tablename__ = "notification_channels"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20))
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    secret: Mapped[str] = mapped_column(Text, default="")


class MaintenanceWindow(Base):
    __tablename__ = "maintenance_windows"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    scope: Mapped[dict] = mapped_column(JSON, default=dict)
    start: Mapped[float] = mapped_column(Float)
    end: Mapped[float] = mapped_column(Float)
    summarized: Mapped[bool] = mapped_column(Boolean, default=False)


class NotificationDelivery(Base):
    __tablename__ = "notification_deliveries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    event_id: Mapped[str] = mapped_column(String(100))
    channel_id: Mapped[str] = mapped_column(String(36))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt: Mapped[float] = mapped_column(Float, default=now)
    error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    __table_args__ = (UniqueConstraint("event_id", "channel_id", name="uq_notification_event_channel"),)
