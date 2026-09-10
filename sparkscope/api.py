"""Versioned fleet API. All remote work is explicitly authenticated and audited."""

import asyncio
import hmac
import logging
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from commands import COMMANDS

from .collector import Collector
from .config import DEFAULT_THRESHOLDS, Settings
from .database import Database
from .extensions import install as install_extensions
from .history import history
from .models import Alert, Audit, Confirmation, Device, Job, NotificationChannel, Preference, Service, Session, User
from .notifications import Notifier
from .runtimes import discover
from .schemas import (
    AddService,
    Connection,
    EditDevice,
    Login,
    Operation,
    Retention,
    SaveDevice,
    Setup,
    Trust,
    UserInput,
    UserUpdate,
)
from .security import RateLimit, Vault, digest, hasher, private_file, token, verify_password
from .ssh import Transport, safe_error

ROOT = Path(__file__).resolve().parent.parent
LOG = logging.getLogger("sparkscope")


def user_public(user):
    return {"id": user.id, "username": user.username, "role": user.role, "active": user.active}


def device_public(d, detail=False):
    now = time.time()
    system = (d.latest or {}).get("system", {})
    smart = (d.latest or {}).get("smart", {})
    status = "paused" if d.paused else d.status
    stale = d.last_seen is None or now - d.last_seen > 15
    if status == "online" and stale:
        status = "degraded"
    metrics = dict(system.get("metrics", {}))
    if smart.get("available") and now - smart.get("ts", 0) < 180:
        metrics.update(smart.get("metrics", {}))
    out = {
        "id": d.id,
        "name": d.name,
        "address": d.address,
        "port": d.port,
        "username": d.username,
        "group": d.group,
        "cluster_name": (d.info or {}).get("cluster_name", ""),
        "tags": d.tags,
        "status": status,
        "paused": d.paused,
        "archived": d.archived,
        "last_seen": d.last_seen,
        "stale": stale,
        "metrics": metrics,
        "info": {
            k: v
            for k, v in (d.info or {}).items()
            if k
            in (
                "hostname",
                "os",
                "gpu",
                "gpus",
                "gpu_count",
                "capabilities",
                "capability_status",
                "capability_details",
                "hardware_checked_at",
                "memory_model",
            )
        },
        "error": d.error,
        "host_key_verified": bool(d.host_key),
        "created_at": d.created_at,
        "revision": d.revision,
    }
    if detail:
        out.update(
            info=d.info,
            sources={"system": system.get("ts"), "smart": smart.get("ts")},
            smart=smart,
            gpu_procs=system.get("gpu_procs", []),
            top_procs=system.get("top_procs", []),
        )
    return out


def service_public(row):
    data = dict(row.data or {})
    if not row.last_seen or time.time() - row.last_seen > 20:
        data["status"] = "unavailable"
    return {
        "id": row.id,
        "device_id": row.device_id,
        "provider": row.provider,
        "port": row.port,
        "path": row.path,
        "manual": row.manual,
        "has_api_key": bool(row.secret),
        "last_seen": row.last_seen,
        **data,
    }


def alert_public(a):
    return {
        k: getattr(a, k)
        for k in (
            "id",
            "device_id",
            "metric",
            "severity",
            "message",
            "first_seen",
            "last_seen",
            "acknowledged_at",
            "acknowledged_by",
            "resolved_at",
            "occurrences",
            "component_id",
        )
    }


def job_public(j):
    return {k: getattr(j, k) for k in ("id", "kind", "status", "created_at", "updated_at", "data", "result")}


async def current_user(request: Request):
    raw = request.cookies.get("sparkscope_session", "")
    async with request.app.state.db.session() as s:
        session = await s.get(Session, digest(raw)) if raw else None
        user = await s.get(User, session.user_id) if session and session.expires > time.time() else None
        if not user or not user.active:
            raise HTTPException(401, "Sign in to continue")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if not hmac.compare_digest(request.headers.get("x-csrf-token", ""), session.csrf):
                raise HTTPException(403, "Session verification failed. Reload and try again.")
        request.state.session = session
        return user


def role(required):
    async def dependency(user=Depends(current_user)):
        levels = {"viewer": 0, "operator": 1, "admin": 2}
        if levels[user.role] < levels[required]:
            raise HTTPException(403, "Your role does not permit this action")
        return user

    return dependency


async def audit(db, user, action, target="", detail=None):
    async with db.session() as s:
        s.add(Audit(actor=user.username, action=action, target=target, detail=detail or {}))


def create_app(settings=None, transport=None):
    settings = settings or Settings()
    db = Database(settings.database_url)
    vault = Vault(settings.key_file)
    transport = transport or Transport(vault)
    collector = Collector(db, transport, settings)
    notifier = Notifier(db, vault)
    background = set()
    auth_limit = RateLimit()
    setup_lock = asyncio.Lock()

    def spawn(coro):
        task = asyncio.create_task(coro)
        background.add(task)
        task.add_done_callback(background.discard)
        return task

    @asynccontextmanager
    async def lifespan(app):
        try:
            await db.migrate()
            async with db.session() as s:
                needs_setup = not await s.scalar(select(func.count()).select_from(User))
            async with db.session() as s:
                for model in (Device, Service, Job, NotificationChannel):
                    rows = await s.stream_scalars(select(model.secret).where(model.secret != ""))
                    async for sealed in rows:
                        try:
                            vault.open(sealed)
                        except Exception:
                            raise RuntimeError(
                                "The master key cannot decrypt saved credentials. Restore the correct key before starting."
                            ) from None
            if needs_setup:
                private_file(settings.data_dir / "setup.secret", token())
                LOG.warning("First-run setup: read the local setup code from %s", settings.data_dir / "setup.secret")
            if settings.collector_enabled:
                await db.acquire_collector()
                await collector.start()
                spawn(notifier.run())
            yield
        finally:
            for task in list(background):
                task.cancel()
            await asyncio.gather(*background, return_exceptions=True)
            await collector.stop()
            await db.close()

    app = FastAPI(title="SparkScope", version="0.3.0", lifespan=lifespan)
    app.state.db = db
    app.state.vault = vault
    app.state.collector = collector
    app.state.transport = transport
    app.state.started_at = time.time()
    app.state.notifier = notifier
    install_extensions(app, db, vault, collector, notifier, current_user, role)
    app.state.settings = settings

    @app.middleware("http")
    async def protections(request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and origin not in settings.origins:
                return JSONResponse({"detail": "Origin not allowed"}, 403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "Cross-site requests are not allowed"}, 403)
            try:
                size = int(request.headers.get("content-length", "0") or 0)
            except ValueError:
                return JSONResponse({"detail": "Invalid content length"}, 400)
            if size > 65536:
                return JSONResponse({"detail": "Request too large"}, 413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation(request, exc):
        return JSONResponse(
            {"detail": "; ".join(".".join(str(x) for x in e["loc"][1:]) + ": " + e["msg"] for e in exc.errors())}, 422
        )

    @app.exception_handler(IntegrityError)
    async def conflict(request, exc):
        return JSONResponse({"detail": "This record already exists or conflicts with another record."}, 409)

    @app.get("/api/v1/health")
    async def health():
        return {"status": "ok", "version": "0.3.0"}

    @app.get("/api/v1/auth/status")
    async def auth_status():
        async with db.session() as s:
            return {"setup_required": not bool(await s.scalar(select(func.count()).select_from(User)))}

    async def issue_session(user):
        raw = token()
        csrf = token()
        async with db.session() as s:
            s.add(
                Session(id=digest(raw), user_id=user.id, csrf=csrf, expires=time.time() + settings.session_hours * 3600)
            )
        response = JSONResponse({"user": user_public(user), "csrf": csrf})
        response.set_cookie(
            "sparkscope_session",
            raw,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            max_age=settings.session_hours * 3600,
            path="/",
        )
        return response

    @app.post("/api/v1/auth/setup")
    async def setup(body: Setup, request: Request):
        if not auth_limit.allow(request.client.host if request.client else "setup"):
            raise HTTPException(429, "Too many attempts. Try again in a minute.")
        if len(body.password) < 12:
            raise HTTPException(422, "Use a password with at least 12 characters")
        async with setup_lock:
            async with db.session() as s:
                if await s.scalar(select(func.count()).select_from(User)):
                    raise HTTPException(409, "Setup has already been completed")
                path = settings.data_dir / "setup.secret"
                if not path.exists() or not secrets.compare_digest(path.read_text().strip(), body.token):
                    raise HTTPException(403, "Invalid local setup code")
                user = User(
                    username=body.username,
                    password_hash=await asyncio.to_thread(hasher.hash, body.password),
                    role="admin",
                )
                s.add(user)
                await s.flush()
            path.unlink(missing_ok=True)
        await audit(db, user, "setup")
        return await issue_session(user)

    @app.post("/api/v1/auth/login")
    async def login(body: Login, request: Request):
        if not auth_limit.allow(request.client.host if request.client else "login"):
            raise HTTPException(429, "Too many attempts. Try again in a minute.")
        async with db.session() as s:
            user = await s.scalar(select(User).where(User.username == body.username))
        if (
            not user
            or not user.active
            or not await asyncio.to_thread(verify_password, body.password, user.password_hash)
        ):
            raise HTTPException(401, "Invalid username or password")
        await audit(db, user, "login")
        return await issue_session(user)

    @app.get("/api/v1/auth/me")
    async def me(request: Request, user=Depends(current_user)):
        return {"user": user_public(user), "csrf": request.state.session.csrf}

    @app.post("/api/v1/auth/logout")
    async def logout(request: Request, user=Depends(current_user)):
        async with db.session() as s:
            await s.execute(delete(Session).where(Session.id == request.state.session.id))
        response = JSONResponse({"ok": True})
        response.delete_cookie("sparkscope_session", path="/")
        return response

    @app.get("/api/v1/users")
    async def users(user=Depends(role("admin"))):
        async with db.session() as s:
            return [user_public(u) for u in (await s.scalars(select(User).order_by(User.username))).all()]

    @app.post("/api/v1/users", status_code=201)
    async def add_user(body: UserInput, user=Depends(role("admin"))):
        async with db.session() as s:
            row = User(
                username=body.username,
                password_hash=await asyncio.to_thread(hasher.hash, body.password),
                role=body.role,
            )
            s.add(row)
            await s.flush()
            out = user_public(row)
        await audit(db, user, "user.create", out["id"])
        return out

    @app.patch("/api/v1/users/{id}")
    async def edit_user(id: str, body: UserUpdate, user=Depends(role("admin"))):
        async with setup_lock:
            async with db.session() as s:
                row = await s.get(User, id)
                if not row:
                    raise HTTPException(404, "User not found")
                if row.role == "admin" and (body.role != "admin" or not body.active):
                    count = await s.scalar(
                        select(func.count()).select_from(User).where(User.role == "admin", User.active.is_(True))
                    )
                    if count <= 1:
                        raise HTTPException(409, "At least one active administrator is required")
                row.role = body.role
                row.active = body.active
                if body.password:
                    row.password_hash = await asyncio.to_thread(hasher.hash, body.password)
                await s.execute(delete(Session).where(Session.user_id == id))
                out = user_public(row)
        await audit(db, user, "user.update", id)
        return out

    @app.get("/api/v1/devices")
    async def devices(user=Depends(current_user), archived: bool = False):
        async with db.session() as s:
            return [
                device_public(d)
                for d in (
                    await s.scalars(select(Device).where(Device.archived == archived).order_by(Device.name))
                ).all()
            ]

    @app.get("/api/v1/devices/{id}")
    async def device(id: str, user=Depends(current_user)):
        async with db.session() as s:
            row = await s.get(Device, id)
            if not row:
                raise HTTPException(404, "Device not found")
            out = device_public(row, True)
            out["services"] = [
                service_public(v) for v in (await s.scalars(select(Service).where(Service.device_id == id))).all()
            ]
            return out

    @app.patch("/api/v1/devices/{id}")
    async def edit_device(id: str, body: EditDevice, user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(Device, id)
            if not row:
                raise HTTPException(404, "Device not found")
            changes = body.model_dump()
            cluster_name = changes.pop("cluster_name")
            if "cluster_name" in body.model_fields_set:
                row.info = {**(row.info or {}), "cluster_name": cluster_name}
            peer = changes.pop("cluster_peer_ip", None)
            if peer is not None:
                row.info = {**row.info, "cluster_peer_ip": peer}
            for k, v in changes.items():
                setattr(row, k, v)
            row.revision += 1
            out = device_public(row)
        await audit(db, user, "device.update", id, body.model_dump())
        return out

    async def probe(id, initial=True):
        conn = None
        try:
            async with db.session() as s:
                job = await s.get(Job, id)
                if not job:
                    return
                identity = vault.open(job.secret)
                job.status = "running"
                job.updated_at = time.time()
                pinned = job.result.get("host_key")
            if initial:
                host_key = await transport.host_key(identity["address"], identity["port"])
                async with db.session() as s:
                    job = await s.get(Job, id)
                    job.result = {"host_key": host_key["public_key"], "fingerprint": host_key["fingerprint"]}
                    job.status = "awaiting_trust"
                    job.updated_at = time.time()
                return
            conn = await transport.connect(identity, pinned)
            info = await transport.info_on(conn)
            services = await discover(transport, conn)
            # One read-only sample validates Linux /proc and reveals interfaces/disk metrics.
            from .parsers import METRIC_COMMAND

            raw = await transport.run_on(conn, METRIC_COMMAND, 8)
            metrics, _, _ = transport.parsers._parse_output(id, raw["stdout"])
            if "memory.total_kb" not in metrics:
                info.setdefault("warnings", []).append("Linux system metrics could not be read.")
            if not services:
                info.setdefault("warnings", []).append(
                    "No supported LLM service found. Add a local endpoint after saving."
                )
            async with db.session() as s:
                job = await s.get(Job, id)
                if job.status == "expired":
                    return
                job.result = {**job.result, "info": info, "services": services}
                job.status = "complete"
                job.updated_at = time.time()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            async with db.session() as s:
                job = await s.get(Job, id)
                if job:
                    job.status = "failed"
                    job.secret = ""
                    job.result = {"error": safe_error(exc)}
                    job.updated_at = time.time()
        finally:
            if conn:
                conn.close()
                await conn.wait_closed()

    @app.post("/api/v1/discoveries", status_code=202)
    async def start_discovery(body: Connection, user=Depends(role("admin"))):
        if not auth_limit.allow("discovery:" + user.id, 5, 60):
            raise HTTPException(429, "Wait before starting another discovery")
        if body.auth_type == "key" and not body.private_key:
            raise HTTPException(422, "Provide an SSH private key")
        async with db.session() as s:
            if body.device_id and not await s.get(Device, body.device_id):
                raise HTTPException(404, "Device not found")
            job = Job(
                kind="discovery",
                owner_id=user.id,
                secret=vault.seal(body.model_dump()),
                data={
                    "address": body.address,
                    "port": body.port,
                    "username": body.username,
                    "device_id": body.device_id,
                },
            )
            s.add(job)
            await s.flush()
            out = job_public(job)
        await audit(db, user, "discovery.start", out["id"], {"address": body.address})
        spawn(probe(out["id"]))
        return out

    @app.post("/api/v1/discoveries/{id}/trust", status_code=202)
    async def trust(id: str, body: Trust, user=Depends(role("admin"))):
        async with db.session() as s:
            job = await s.get(Job, id)
            if not job or job.owner_id != user.id:
                raise HTTPException(404, "Discovery not found")
            if job.status != "awaiting_trust" or job.created_at < time.time() - 900:
                raise HTTPException(409, "Discovery expired or is not awaiting verification")
            if not hmac.compare_digest(body.fingerprint, job.result["fingerprint"]):
                raise HTTPException(409, "Host fingerprint does not match")
            job.status = "running"
            job.updated_at = time.time()
        await audit(db, user, "ssh.trust", id, {"fingerprint": body.fingerprint})
        spawn(probe(id, False))
        return {"id": id, "status": "running"}

    @app.post("/api/v1/devices", status_code=201)
    async def save_device(body: SaveDevice, user=Depends(role("admin"))):
        async with setup_lock:
            async with db.session() as s:
                job = await s.get(Job, body.discovery_id)
                if not job or job.kind != "discovery" or job.owner_id != user.id:
                    raise HTTPException(404, "Discovery not found")
                if job.status != "complete" or not job.secret or job.created_at < time.time() - 900:
                    raise HTTPException(409, "Complete a fresh connection test before saving")
                identity = vault.open(job.secret)
                existing_id = identity.pop("device_id", None)
                row = await s.get(Device, existing_id) if existing_id else None
                if existing_id and not row:
                    raise HTTPException(404, "Device no longer exists")
                if not row:
                    row = Device()
                    s.add(row)
                else:
                    row.revision += 1
                for key in ("address", "port", "username"):
                    setattr(row, key, identity.pop(key))
                row.name = body.name
                row.group = body.group
                row.tags = body.tags
                row.secret = vault.seal(identity)
                row.host_key = job.result["host_key"]
                row.info = {**(row.info or {}), **job.result["info"]}
                if not existing_id or "cluster_name" in body.model_fields_set:
                    row.info = {**row.info, "cluster_name": body.cluster_name}
                row.error = None
                await s.flush()
                for item in job.result.get("services", []):
                    existing = await s.scalar(
                        select(Service).where(
                            Service.device_id == row.id, Service.port == item["port"], Service.path == item["path"]
                        )
                    )
                    if not existing:
                        s.add(
                            Service(
                                device_id=row.id,
                                provider=item["provider"],
                                port=item["port"],
                                path=item["path"],
                                data=item["data"],
                                last_seen=time.time(),
                            )
                        )
                job.secret = ""
                job.status = "saved"
                job.updated_at = time.time()
                out = device_public(row)
        await audit(db, user, "device.save", out["id"])
        return out

    @app.post("/api/v1/devices/{id}/rediscover", status_code=202)
    async def rediscover(id: str, user=Depends(role("admin"))):
        async with db.session() as s:
            row = await s.get(Device, id)
            if not row:
                raise HTTPException(404, "Device not found")
            if not row.host_key:
                raise HTTPException(409, "Verify the SSH host key first")
            job = Job(kind="rediscovery", owner_id=user.id, data={"device_id": id})
            s.add(job)
            await s.flush()
            out = job_public(job)

        async def work():
            try:
                await collector.discover_services(row)
                result = {"message": "Service discovery completed"}
                status = "complete"
            except Exception as exc:
                result = {"error": safe_error(exc)}
                status = "failed"
            async with db.session() as s:
                j = await s.get(Job, out["id"])
                j.status = status
                j.result = result
                j.updated_at = time.time()

        spawn(work())
        await audit(db, user, "device.rediscover", id)
        return out

    @app.get("/api/v1/services")
    async def services(user=Depends(current_user)):
        async with db.session() as s:
            return [
                service_public(v)
                for v in (
                    await s.scalars(
                        select(Service).join(Device, Service.device_id == Device.id).where(Device.archived.is_(False))
                    )
                ).all()
            ]

    @app.post("/api/v1/devices/{id}/services", status_code=201)
    async def add_service(id: str, body: AddService, user=Depends(role("admin"))):
        async with db.session() as s:
            if not await s.get(Device, id):
                raise HTTPException(404, "Device not found")
            row = await s.scalar(
                select(Service).where(
                    Service.device_id == id, Service.port == body.port, Service.path == body.path.rstrip("/")
                )
            )
            if not row:
                row = Service(device_id=id, provider=body.provider, port=body.port, path=body.path.rstrip("/"))
                s.add(row)
            row.provider = body.provider
            row.manual = True
            row.secret = vault.seal({"api_key": body.api_key}) if body.api_key else ""
            await s.flush()
            out = service_public(row)
        await audit(db, user, "service.save", out["id"])
        return out

    @app.get("/api/v1/history")
    async def metric_history(
        device_id: str,
        metric: str,
        from_ts: float,
        to_ts: float | None = None,
        source: str = "system",
        max_points: int = 300,
        user=Depends(current_user),
    ):
        end = to_ts or time.time()
        if end <= from_ts or end - from_ts > 366 * 86400 or not 10 <= max_points <= 600 or len(metric) > 100:
            raise HTTPException(422, "Invalid time range or point limit")
        return await history(db, device_id, metric, from_ts, end, max_points, source)

    @app.get("/api/v1/alerts")
    async def alerts(user=Depends(current_user)):
        async with db.session() as s:
            return [
                alert_public(a)
                for a in (await s.scalars(select(Alert).order_by(Alert.first_seen.desc()).limit(1000))).all()
            ]

    @app.post("/api/v1/alerts/{id}/acknowledge")
    async def acknowledge(id: str, user=Depends(role("operator"))):
        async with db.session() as s:
            row = await s.get(Alert, id)
            if not row:
                raise HTTPException(404, "Alert not found")
            row.acknowledged_at = time.time()
            row.acknowledged_by = user.username
        await audit(db, user, "alert.acknowledge", id)
        return {"ok": True}

    @app.get("/api/v1/commands")
    async def commands(user=Depends(current_user)):
        return [
            {
                "key": key,
                "label": v["label"],
                "category": v["category"],
                "destructive": v["destructive"],
                "confirmation_text": v.get("confirmation_text"),
                "timeout_seconds": 1800 if v.get("long_running") else 30,
            }
            for key, v in COMMANDS.items()
        ]

    async def validate_targets(body, user):
        cmd = COMMANDS.get(body.command)
        if not cmd:
            raise HTTPException(422, "Unknown command")
        if user.role == "viewer" or (cmd["destructive"] and user.role != "admin"):
            raise HTTPException(403, "Your role does not permit this command")
        ids = sorted(set(body.device_ids))
        async with db.session() as s:
            rows = (await s.scalars(select(Device).where(Device.id.in_(ids), Device.archived.is_(False)))).all()
        if len(rows) != len(ids):
            raise HTTPException(404, "One or more selected devices no longer exist")
        if any(d.paused or not d.host_key for d in rows):
            raise HTTPException(409, "Resume monitoring and verify SSH identity on all selected devices first")
        return cmd, ids, rows

    @app.post("/api/v1/operations/confirmations")
    async def confirm(body: Operation, user=Depends(role("admin"))):
        cmd, ids, _ = await validate_targets(body, user)
        if not cmd["destructive"]:
            raise HTTPException(422, "This command does not require confirmation")
        value = token()
        async with db.session() as s:
            s.add(
                Confirmation(
                    id=digest(value), user_id=user.id, command=body.command, device_ids=ids, expires=time.time() + 120
                )
            )
        return {"confirmation": value, "expires_in": 120, "device_ids": ids, "message": cmd["confirmation_text"]}

    async def execute_job(id, cmd, devices):
        async with db.session() as s:
            job = await s.get(Job, id)
            job.status = "running"
            job.updated_at = time.time()
        all_ok = True
        for original in devices:
            async with db.session() as s:
                current = await s.get(Device, original.id)
                job = await s.get(Job, id)
                owner = await s.get(User, job.owner_id)
            if (
                not current
                or current.archived
                or current.paused
                or current.revision != original.revision
                or not owner
                or not owner.active
                or (cmd["destructive"] and owner.role != "admin")
                or owner.role == "viewer"
            ):
                result = {
                    "exit_code": None,
                    "stdout": "",
                    "stderr": "Device or access changed before execution. The command was not sent.",
                    "timed_out": False,
                }
            else:
                command = cmd["command"]
                if "{peer_ip}" in command:
                    import ipaddress

                    try:
                        peer = str(ipaddress.ip_address(current.info.get("cluster_peer_ip", "")))
                    except ValueError:
                        peer = None
                    command = command.replace("{peer_ip}", peer or "")
                    if not peer:
                        result = {
                            "exit_code": None,
                            "stdout": "",
                            "stderr": "Configure a valid cluster peer IP before running this command.",
                            "timed_out": False,
                        }
                    else:
                        result = None
                else:
                    result = None
                if result is None:
                    try:
                        result = await transport.run(current, command, 1800 if cmd.get("long_running") else 30)
                    except Exception as exc:
                        result = {"exit_code": None, "stdout": "", "stderr": safe_error(exc), "timed_out": False}
            ok = result.get("exit_code") == 0 and not result.get("timed_out")
            all_ok = all_ok and ok
            async with db.session() as s:
                job = await s.get(Job, id)
                job.result = {**job.result, original.id: result}
                job.updated_at = time.time()
                s.add(
                    Audit(
                        actor=owner.username if owner else "removed user",
                        action="command.result",
                        target=original.id,
                        detail={
                            "job_id": id,
                            "exit_code": result.get("exit_code"),
                            "timed_out": result.get("timed_out", False),
                        },
                    )
                )
        async with db.session() as s:
            job = await s.get(Job, id)
            job.status = "complete" if all_ok else "failed"
            job.updated_at = time.time()

    @app.post("/api/v1/operations", status_code=202)
    async def operation(body: Operation, user=Depends(role("operator"))):
        cmd, ids, rows = await validate_targets(body, user)
        async with db.session() as s:
            running = await s.scalar(
                select(func.count())
                .select_from(Job)
                .where(Job.kind == "command", Job.status.in_(["queued", "running"]))
            )
            if running >= 10:
                raise HTTPException(429, "Too many operations are running. Wait for one to finish.")
            if cmd["destructive"]:
                proof = await s.get(Confirmation, digest(body.confirmation or ""))
                if (
                    not proof
                    or proof.user_id != user.id
                    or proof.command != body.command
                    or proof.device_ids != ids
                    or proof.expires < time.time()
                ):
                    raise HTTPException(403, "Confirm this command for the selected devices before running it")
                consumed = await s.execute(delete(Confirmation).where(Confirmation.id == proof.id))
                if consumed.rowcount != 1:
                    raise HTTPException(409, "This confirmation has already been used")
            job = Job(
                kind="command",
                owner_id=user.id,
                data={"command": body.command, "device_ids": ids, "device_names": {d.id: d.name for d in rows}},
            )
            s.add(job)
            await s.flush()
            out = job_public(job)
            s.add(Audit(actor=user.username, action="command.start", target=job.id, detail=job.data))
        spawn(execute_job(out["id"], cmd, rows))
        return out

    @app.get("/api/v1/jobs")
    async def jobs(user=Depends(current_user)):
        async with db.session() as s:
            query = select(Job).where(Job.kind != "discovery").order_by(Job.created_at.desc()).limit(100)
            return [job_public(j) for j in (await s.scalars(query)).all()]

    @app.get("/api/v1/jobs/{id}")
    async def job(id: str, user=Depends(current_user)):
        async with db.session() as s:
            row = await s.get(Job, id)
            if not row or (row.kind == "discovery" and (row.owner_id != user.id or user.role != "admin")):
                raise HTTPException(404, "Job not found")
            return job_public(row)

    @app.get("/api/v1/settings")
    async def preferences(user=Depends(role("admin"))):
        async with db.session() as s:
            rules = await s.get(Preference, "thresholds")
            retention = await s.get(Preference, "retention")
            groups = await s.get(Preference, "groups")
            return {
                "thresholds": rules.value if rules else DEFAULT_THRESHOLDS,
                "groups": groups.value.get("names", []) if groups else ["Default"],
                "retention": retention.value if retention else Retention().model_dump(),
                "collector": collector.metrics,
                "poll_seconds": settings.poll_seconds,
                "database": "PostgreSQL" if settings.database_url.startswith("postgresql") else "SQLite",
            }

    @app.put("/api/v1/settings/retention")
    async def retention(body: Retention, user=Depends(role("admin"))):
        if body.raw_hours > body.minute_days * 24 or body.minute_days > body.quarter_days:
            raise HTTPException(422, "Retention intervals must increase from raw to minute to quarter-hour data")
        async with db.session() as s:
            await s.merge(Preference(key="retention", value=body.model_dump()))
        await audit(db, user, "settings.retention", detail=body.model_dump())
        return body

    @app.put("/api/v1/settings/thresholds")
    async def thresholds(request: Request, user=Depends(role("admin"))):
        import math

        body = await request.json()
        if not isinstance(body, dict) or set(body) != set(DEFAULT_THRESHOLDS):
            raise HTTPException(422, "Supply all supported metric thresholds")
        for key, pair in body.items():
            if (
                not isinstance(pair, list)
                or len(pair) != 2
                or not isinstance(pair[0], (int, float))
                or not math.isfinite(pair[0])
                or pair[0] < 0
                or (
                    pair[1] is not None
                    and (not isinstance(pair[1], (int, float)) or not math.isfinite(pair[1]) or pair[1] < pair[0])
                )
            ):
                raise HTTPException(422, f"Invalid thresholds for {key}")
        async with db.session() as s:
            await s.merge(Preference(key="thresholds", value=body))
        collector.alerts.counters.clear()
        await audit(db, user, "settings.thresholds", detail=body)
        return body

    @app.put("/api/v1/settings/groups")
    async def groups(request: Request, user=Depends(role("admin"))):
        body = await request.json()
        names = body.get("names") if isinstance(body, dict) else None
        if (
            not isinstance(names, list)
            or len(names) > 100
            or any(not isinstance(n, str) or not n.strip() or len(n) > 100 for n in names)
        ):
            raise HTTPException(422, "Provide up to 100 group names")
        names = sorted(set(["Default"] + [n.strip() for n in names]))
        async with db.session() as s:
            await s.merge(Preference(key="groups", value={"names": names}))
        await audit(db, user, "settings.groups")
        return {"names": names}

    @app.get("/api/v1/audit")
    async def audits(user=Depends(role("admin"))):
        async with db.session() as s:
            return [
                {"id": a.id, "ts": a.ts, "actor": a.actor, "action": a.action, "target": a.target, "detail": a.detail}
                for a in (await s.scalars(select(Audit).order_by(Audit.ts.desc()).limit(200))).all()
            ]

    @app.websocket("/api/v1/live")
    async def live(ws: WebSocket):
        if ws.headers.get("origin") not in settings.origins:
            await ws.close(code=1008)
            return
        raw = ws.cookies.get("sparkscope_session", "")
        previous = {}
        first = True
        try:
            async with db.session() as s:
                session = await s.get(Session, digest(raw)) if raw else None
                account = await s.get(User, session.user_id) if session and session.expires > time.time() else None
            if not account or not account.active:
                await ws.close(code=1008)
                return
            await ws.accept()
            while True:
                async with db.session() as s:
                    session = await s.get(Session, digest(raw))
                    account = await s.get(User, session.user_id) if session and session.expires > time.time() else None
                    if not account or not account.active:
                        await ws.close(code=1008)
                        return
                    devices = [
                        device_public(d)
                        for d in (
                            await s.scalars(select(Device).where(Device.archived.is_(False)).order_by(Device.name))
                        ).all()
                    ]
                    alerts = [
                        alert_public(a)
                        for a in (
                            await s.scalars(
                                select(Alert)
                                .where(Alert.resolved_at.is_(None))
                                .order_by(Alert.first_seen.desc())
                                .limit(1000)
                            )
                        ).all()
                    ]
                current = {d["id"]: d for d in devices}
                changed = devices if first else [d for d in devices if previous.get(d["id"]) != d]
                payload = {
                    "type": "snapshot" if first else "patch",
                    "devices": changed,
                    "removed": [k for k in previous if k not in current],
                    "alerts": alerts,
                    "ts": time.time(),
                }
                await asyncio.wait_for(ws.send_json(payload), 2)
                previous = current
                first = False
                try:
                    text = await asyncio.wait_for(ws.receive_text(), 2)
                    if len(text) > 1000:
                        await ws.close(code=1008)
                        return
                    # Even chatty clients cannot force unbounded database reads.
                    await asyncio.sleep(2)
                except asyncio.TimeoutError:
                    pass
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            pass

    static = ROOT / "frontend" / "dist"
    if static.exists():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

    @app.get("/{path:path}")
    async def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "API endpoint not found")
        if path == "device.svg":
            return FileResponse(ROOT / "frontend" / "public" / "device.svg")
        if not (static / "index.html").exists():
            return JSONResponse(
                {"detail": "Build the frontend with npm run build in frontend/, or use the Vite development URL."}, 503
            )
        return FileResponse(static / "index.html")

    return app
