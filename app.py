"""GB10 Cluster Dashboard — FastAPI application with WebSocket real-time updates."""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
from commands import COMMANDS, get_commands_grouped
from ssh_collector import SSHPool
from vllm_collector import collect_vllm
from mock_collector import MockCollector, mock_vllm_collect

# --- Config ---
# In demo mode, use bundled config.demo.yaml if present; otherwise config.yaml.
DEMO_MODE = os.environ.get("DEMO_MODE", "").lower() in ("1", "true", "yes")
CONFIG_PATH = Path(__file__).parent / ("config.demo.yaml" if DEMO_MODE else "config.yaml")
if not CONFIG_PATH.exists() and DEMO_MODE:
    CONFIG_PATH = Path(__file__).parent / "config.example.yaml"
with open(CONFIG_PATH) as f:
    config = yaml.safe_load(f)
# Allow config.yaml to toggle demo mode too
if config.get("demo_mode"):
    DEMO_MODE = True

# --- Logging ---
log_dir = Path("~/.gb10-dashboard").expanduser()
log_dir.mkdir(parents=True, exist_ok=True)
handler = RotatingFileHandler(log_dir / "dashboard.log", maxBytes=10 * 1024 * 1024, backupCount=3)
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
logging.basicConfig(level=getattr(logging, config["server"]["log_level"].upper(), logging.INFO), handlers=[handler, logging.StreamHandler()])
logging.getLogger("asyncssh").setLevel(logging.WARNING)
logger = logging.getLogger("gb10")

# --- Globals ---
ssh_pool: SSHPool | None = None
latest_data: dict = {}  # {host: {metrics, gpu_procs, top_procs, online, vllm}}
alert_consecutive: dict = {}  # {host.category.metric: count}
ws_clients: set[WebSocket] = set()
vllm_state: dict = {}  # {host: prev_vllm_dict} — for computing token/sec deltas


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ssh_pool
    db.set_db_path(config["database"]["path"])
    await db.init_db()

    if DEMO_MODE:
        logger.info("🎭 DEMO MODE enabled — using MockCollector (no real SSH)")
        ssh_pool = MockCollector(hosts=config["hosts"])
    else:
        ssh_pool = SSHPool(
            hosts=config["hosts"],
            timeout=config["polling"]["timeout_seconds"],
            backoff=config["polling"]["reconnect_backoff_seconds"],
        )

    poll_task = asyncio.create_task(polling_loop())
    retention_task = asyncio.create_task(retention_loop())
    nvme_task = None if DEMO_MODE else asyncio.create_task(nvme_slow_poll())

    yield

    poll_task.cancel()
    retention_task.cancel()
    if nvme_task is not None:
        nvme_task.cancel()
    if ssh_pool:
        await ssh_pool.close_all()
    await db.close_db()


app = FastAPI(title="GB10 Dashboard", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


# --- Background tasks ---

async def polling_loop():
    interval = config["polling"]["interval_seconds"]
    while True:
        try:
            await collect_all()
            await broadcast_ws()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Polling error: {e}")
        await asyncio.sleep(interval)


async def collect_all():
    global latest_data
    tasks = {name: ssh_pool.collect(name) for name in config["hosts"]}
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)

    ts = int(time.time())
    for host_name, result in zip(tasks.keys(), results):
        if isinstance(result, Exception) or result is None:
            latest_data.setdefault(host_name, {})["online"] = False
            continue

        metrics, gpu_procs, top_procs = result

        # Collect vLLM state (async, best-effort — don't block main metrics)
        vllm_data = None
        try:
            if DEMO_MODE:
                vllm_data = await mock_vllm_collect(ssh_pool, host_name, vllm_state.get(host_name))
            else:
                vllm_data = await asyncio.wait_for(
                    collect_vllm(ssh_pool, host_name, vllm_state.get(host_name)),
                    timeout=4.0,
                )
            if vllm_data:
                vllm_state[host_name] = vllm_data
        except (asyncio.TimeoutError, Exception) as e:
            logger.debug(f"vLLM collect skipped for {host_name}: {e}")

        latest_data[host_name] = {
            "metrics": metrics,
            "gpu_procs": gpu_procs,
            "top_procs": top_procs,
            "vllm": vllm_data,
            "online": True,
            "ts": ts,
        }

        await db.insert_metrics(host_name, metrics, ts)
        if gpu_procs:
            await db.insert_gpu_processes(host_name, gpu_procs, ts)

        # Persist vLLM metrics to DB for historical trend
        if vllm_data:
            vllm_metrics = {
                "vllm.requests_running": vllm_data.get("requests_running", 0),
                "vllm.requests_waiting": vllm_data.get("requests_waiting", 0),
                "vllm.kv_cache_pct": vllm_data.get("kv_cache_pct", 0),
                "vllm.gen_tokens_per_s": vllm_data.get("gen_tokens_per_s", 0),
                "vllm.prompt_tokens_per_s": vllm_data.get("prompt_tokens_per_s", 0),
                "vllm.prefix_cache_hit_pct": vllm_data.get("prefix_cache_hit_pct", 0),
            }
            await db.insert_metrics(host_name, vllm_metrics, ts)

        await check_alerts(host_name, metrics)


async def check_alerts(host: str, metrics: dict):
    thresholds = config["thresholds"]
    checks = [
        ("cpu.temp_max_c", "cpu", thresholds["cpu_temp_warning"], thresholds["cpu_temp_critical"], "CPU temperature"),
        ("gpu.temp_c", "gpu", thresholds["gpu_temp_warning"], thresholds["gpu_temp_critical"], "GPU temperature"),
        ("gpu.power_draw_w", "gpu", thresholds["gpu_power_warning"], None, "GPU power draw"),
        ("disk.root_used_pct", "disk", thresholds["disk_usage_warning"], thresholds["disk_usage_critical"], "Disk usage"),
        ("memory.used_pct", "memory", thresholds["memory_usage_warning"], None, "Memory usage"),
        ("gpu.ecc_uncorrected", "gpu", 1, 1, "GPU ECC uncorrected error"),
        ("gpu.throttle_active", "gpu", 1, None, "GPU throttling active"),
    ]

    for metric_key, category, warn_thr, crit_thr, label in checks:
        value = metrics.get(metric_key)
        if value is None:
            continue

        alert_key = f"{host}.{metric_key}"

        if crit_thr and value >= crit_thr:
            alert_consecutive[alert_key] = alert_consecutive.get(alert_key, 0) + 1
            if alert_consecutive[alert_key] >= 3:
                await db.insert_alert(host, category, "critical", f"{label}: {value:.1f} (threshold: {crit_thr})")
        elif value >= warn_thr:
            alert_consecutive[alert_key] = alert_consecutive.get(alert_key, 0) + 1
            if alert_consecutive[alert_key] >= 3:
                await db.insert_alert(host, category, "warning", f"{label}: {value:.1f} (threshold: {warn_thr})")
        else:
            if alert_consecutive.get(alert_key, 0) >= 3:
                await db.resolve_alerts_by_category(host, category)
            alert_consecutive[alert_key] = 0


async def nvme_slow_poll():
    """Collect NVMe SMART data every 60 seconds (separate from fast metric poll)."""
    await asyncio.sleep(15)  # Wait for main polling to stabilize
    while True:
        try:
            for host_name in config["hosts"]:
                if not ssh_pool or not ssh_pool.online_status.get(host_name):
                    continue
                cmd = "sudo nvme smart-log /dev/nvme0n1 2>/dev/null | grep -E '^(temperature|available_spare|percentage_used|media_errors|critical_warning)' | head -10"
                r = await ssh_pool.run_command(host_name, cmd)
                out = r.get("stdout", "") or ""
                metrics = {}
                for line in out.split("\n"):
                    if ":" not in line:
                        continue
                    key, val = line.split(":", 1)
                    key = key.strip()
                    val = val.strip().split()[0] if val.strip() else "0"
                    try:
                        # Temperature like "40 C" or "40"
                        v = float(val.replace("%", "").replace("C", "").strip() or "0")
                    except (ValueError, TypeError):
                        continue
                    mkey = {
                        "temperature": "nvme.temp_c",
                        "available_spare": "nvme.spare_pct",
                        "percentage_used": "nvme.used_pct",
                        "media_errors": "nvme.media_errors",
                        "critical_warning": "nvme.critical_warning",
                    }.get(key)
                    if mkey:
                        metrics[mkey] = v
                if metrics:
                    await db.insert_metrics(host_name, metrics)
                    # Merge into live data so UI can show it
                    latest_data.setdefault(host_name, {}).setdefault("metrics", {}).update(metrics)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"NVMe slow poll error: {e}")
        await asyncio.sleep(60)


async def retention_loop():
    retention = config["database"]["raw_retention_hours"]
    vacuum_interval = config["database"]["vacuum_interval_hours"] * 3600
    last_vacuum = 0
    while True:
        await asyncio.sleep(300)  # run every 5 min
        try:
            now = time.time()
            do_vacuum = (now - last_vacuum) >= vacuum_interval
            await db.run_retention(retention, vacuum=do_vacuum)
            if do_vacuum:
                last_vacuum = now
                logger.info("Retention + VACUUM completed")
            else:
                logger.info("Retention cleanup completed")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Retention error: {e}")


async def _safe_send(ws: WebSocket, msg: str):
    try:
        await asyncio.wait_for(ws.send_text(msg), timeout=2.0)
        return ws, None
    except Exception as e:
        return ws, e


async def broadcast_ws():
    global ws_clients
    if not ws_clients:
        return
    payload = build_ws_payload()
    msg = json.dumps(payload)
    # Send to all clients in parallel — slow client can't block others
    results = await asyncio.gather(*[_safe_send(ws, msg) for ws in list(ws_clients)], return_exceptions=True)
    dead = set()
    for r in results:
        if isinstance(r, tuple) and r[1] is not None:
            dead.add(r[0])
        elif isinstance(r, Exception):
            pass
    ws_clients -= dead


def build_ws_payload() -> dict:
    hosts = {}
    for name, cfg in config["hosts"].items():
        host_data = latest_data.get(name, {})
        hosts[name] = {
            "display_name": cfg["display_name"],
            "online": host_data.get("online", False),
            "metrics": host_data.get("metrics", {}),
            "gpu_procs": host_data.get("gpu_procs", []),
            "top_procs": host_data.get("top_procs", []),
            "vllm": host_data.get("vllm"),
            "ts": host_data.get("ts", 0),
        }
    return {"type": "metrics", "hosts": hosts, "ts": int(time.time())}


# --- Routes ---

@app.get("/")
async def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/api/hosts")
async def api_hosts():
    result = {}
    for name, cfg in config["hosts"].items():
        host_data = latest_data.get(name, {})
        result[name] = {
            "display_name": cfg["display_name"],
            "online": host_data.get("online", False),
            "ssh_alias": cfg["ssh_alias"],
        }
    return result


_host_info_cache: dict = {}  # cleared on restart — config changes require restart


@app.get("/api/hosts/{host}/info")
async def api_host_info(host: str):
    """Get static host info (hostname, kernel, OS, IP) — cached for 5 min."""
    if host not in config["hosts"]:
        raise HTTPException(404, "Unknown host")

    now = int(time.time())
    cached = _host_info_cache.get(host)
    if cached and (now - cached["ts"]) < 300:
        return cached["data"]

    cfg = config["hosts"][host]
    if ssh_pool is None:
        return {"error": "SSH pool not ready"}

    if DEMO_MODE:
        # Return fake but realistic static info
        info = {
            "name": host,
            "display_name": cfg["display_name"],
            "ssh_alias": cfg["ssh_alias"],
            "management_ip": cfg.get("management_ip", ""),
            "cluster_ip": cfg.get("cluster_ip", ""),
            "cluster_peer_ip": cfg.get("cluster_peer_ip", ""),
            "hostname": host,
            "ip": cfg.get("cluster_ip", "192.168.100.10"),
            "kernel": "6.17.0-1014-nvidia",
            "os": "Ubuntu 24.04.4 LTS (DGX OS)",
            "gpu": "NVIDIA GB10, 580.126.09",
        }
        _host_info_cache[host] = {"ts": now, "data": info}
        return info

    cmd = "hostname && hostname -I | awk '{print $1}' && uname -r && (lsb_release -d 2>/dev/null | cut -f2- || cat /etc/os-release | grep PRETTY_NAME | cut -d'\"' -f2) && nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -1"
    r = await ssh_pool.run_command(host, cmd)
    lines = (r.get("stdout", "") or "").strip().split("\n")

    def safe_get(idx):
        return lines[idx].strip() if idx < len(lines) else ""

    info = {
        "name": host,
        "display_name": cfg["display_name"],
        "ssh_alias": cfg["ssh_alias"],
        "management_ip": cfg.get("management_ip", ""),
        "cluster_ip": cfg.get("cluster_ip", ""),
        "cluster_peer_ip": cfg.get("cluster_peer_ip", ""),
        "hostname": safe_get(0),
        "ip": safe_get(1),
        "kernel": safe_get(2),
        "os": safe_get(3),
        "gpu": safe_get(4),
    }
    _host_info_cache[host] = {"ts": now, "data": info}
    return info


@app.get("/api/metrics/latest")
async def api_metrics_latest():
    return build_ws_payload()


@app.get("/api/metrics/history")
async def api_metrics_history(host: str, category: str, metric: str, from_ts: int = 0, to_ts: int = 0):
    if not to_ts:
        to_ts = int(time.time())
    if not from_ts:
        from_ts = to_ts - config["ui"]["chart_history_minutes"] * 60
    data = await db.get_metric_history(host, category, metric, from_ts, to_ts)
    return data


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    await websocket.accept()
    ws_clients.add(websocket)
    try:
        # Send initial data
        payload = build_ws_payload()
        await websocket.send_text(json.dumps(payload))
        # Keep alive
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                if msg == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(websocket)


# --- Commands ---

@app.get("/api/commands")
async def api_commands():
    return get_commands_grouped()


class CommandRequest(BaseModel):
    host: str
    key: str


@app.post("/api/commands/execute")
async def api_execute_command(req: CommandRequest):
    if req.key not in COMMANDS:
        raise HTTPException(400, "Unknown command key")
    cmd = COMMANDS[req.key]

    hosts_to_run = []
    if req.host == "all":
        hosts_to_run = list(config["hosts"].keys())
    elif req.host in config["hosts"]:
        hosts_to_run = [req.host]
    else:
        raise HTTPException(400, "Unknown host")

    results = {}
    for h in hosts_to_run:
        # Substitute per-host placeholders (e.g. {peer_ip}) from config
        host_cfg = config["hosts"][h]
        if "{" in cmd["command"]:
            cmd_text = cmd["command"].format(
                peer_ip=host_cfg.get("cluster_peer_ip", ""),
                host=h,
            )
        else:
            cmd_text = cmd["command"]
        r = await ssh_pool.run_command(h, cmd_text)
        await db.insert_command_log(h, req.key, cmd_text, r["exit_code"], r["stdout"], r["stderr"], r["duration_ms"])
        results[h] = r

    return results


@app.get("/api/commands/history")
async def api_command_history():
    return await db.get_command_history(50)


# --- Alerts ---

@app.get("/api/alerts")
async def api_alerts():
    active = await db.get_active_alerts()
    recent = await db.get_recent_alerts(24)
    return {"active": active, "recent": recent}


@app.post("/api/alerts/{alert_id}/resolve")
async def api_resolve_alert(alert_id: int):
    await db.resolve_alert(alert_id)
    return {"ok": True}
