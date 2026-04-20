"""vLLM inference server detection + metrics collection per host."""

import asyncio
import logging
import re
from typing import Optional

logger = logging.getLogger("gb10.vllm")

# vLLM metrics we care about (Prometheus text format)
_METRIC_KEYS = {
    "vllm:num_requests_running": "requests_running",
    "vllm:num_requests_waiting": "requests_waiting",
    "vllm:kv_cache_usage_perc": "kv_cache_pct",
    "vllm:prompt_tokens_total": "prompt_tokens_total",
    "vllm:generation_tokens_total": "generation_tokens_total",
    "vllm:prefix_cache_queries_total": "prefix_cache_queries_total",
    "vllm:prefix_cache_hits_total": "prefix_cache_hits_total",
}


async def detect_vllm(ssh_pool, host_name: str) -> Optional[dict]:
    """Detect vLLM container + port on a host. Returns {port, container, image} or None."""
    # Look for vllm in running containers (no sudo — user is in docker group)
    cmd = "docker ps --filter name=vllm --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null"
    r = await ssh_pool.run_command(host_name, cmd)
    out = (r.get("stdout") or "").strip()
    if not out:
        return None

    # Parse first line (deduped)
    seen = set()
    for line in out.split("\n"):
        if not line or line in seen:
            continue
        seen.add(line)
        parts = line.split("|")
        if len(parts) < 3:
            continue
        container, image, ports = parts[0], parts[1], parts[2]
        # Extract published port (e.g. "0.0.0.0:8000->8000/tcp")
        port_match = re.search(r":(\d+)->", ports)
        port = int(port_match.group(1)) if port_match else 8000
        return {"container": container, "image": image, "port": port}
    return None


async def fetch_vllm_models(ssh_pool, host_name: str, port: int) -> list[dict]:
    """Get loaded model list via vLLM /v1/models."""
    cmd = f"curl -s --max-time 3 http://localhost:{port}/v1/models"
    r = await ssh_pool.run_command(host_name, cmd)
    try:
        import json
        data = json.loads(r.get("stdout") or "{}")
        return data.get("data", [])
    except Exception:
        return []


async def fetch_vllm_metrics(ssh_pool, host_name: str, port: int) -> dict:
    """Scrape Prometheus metrics from vLLM /metrics endpoint."""
    cmd = f"curl -s --max-time 3 http://localhost:{port}/metrics"
    r = await ssh_pool.run_command(host_name, cmd)
    raw = r.get("stdout") or ""
    if not raw:
        return {}

    metrics: dict = {}
    for line in raw.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Parse: metric_name{labels} value
        # We care about metric name before { or space
        for prom_key, field_name in _METRIC_KEYS.items():
            if line.startswith(prom_key):
                # Find the value (last token)
                parts = line.rsplit(None, 1)
                if len(parts) == 2:
                    try:
                        val = float(parts[1])
                        # If metric has labels, aggregate across them (sum)
                        metrics[field_name] = metrics.get(field_name, 0.0) + val
                    except ValueError:
                        pass
                break
    return metrics


async def collect_vllm(ssh_pool, host_name: str, prev_state: Optional[dict] = None) -> Optional[dict]:
    """Full collection: detect → models → metrics. Returns a flat dict with computed rates."""
    vllm_info = await detect_vllm(ssh_pool, host_name)
    if not vllm_info:
        return None

    port = vllm_info["port"]
    models = await fetch_vllm_models(ssh_pool, host_name, port)
    metrics = await fetch_vllm_metrics(ssh_pool, host_name, port)

    # Compute token throughput (tokens/sec) from delta if we have previous state
    import time
    now = time.monotonic()
    gen_rate = 0.0
    prompt_rate = 0.0
    cache_hit_pct = 0.0
    if prev_state:
        dt = now - prev_state.get("ts", now)
        if dt > 0:
            gen_rate = max(0, (metrics.get("generation_tokens_total", 0) - prev_state.get("generation_tokens_total", 0)) / dt)
            prompt_rate = max(0, (metrics.get("prompt_tokens_total", 0) - prev_state.get("prompt_tokens_total", 0)) / dt)

    queries = metrics.get("prefix_cache_queries_total", 0)
    hits = metrics.get("prefix_cache_hits_total", 0)
    if queries > 0:
        cache_hit_pct = (hits / queries) * 100

    primary_model = models[0] if models else None
    result = {
        "active": True,
        "container": vllm_info["container"],
        "port": port,
        "image": vllm_info["image"],
        "model": primary_model.get("id") if primary_model else None,
        "model_root": primary_model.get("root") if primary_model else None,
        "max_model_len": primary_model.get("max_model_len") if primary_model else None,
        "models_count": len(models),
        "requests_running": metrics.get("requests_running", 0),
        "requests_waiting": metrics.get("requests_waiting", 0),
        "kv_cache_pct": metrics.get("kv_cache_pct", 0) * 100,
        "prompt_tokens_total": metrics.get("prompt_tokens_total", 0),
        "generation_tokens_total": metrics.get("generation_tokens_total", 0),
        "gen_tokens_per_s": round(gen_rate, 2),
        "prompt_tokens_per_s": round(prompt_rate, 2),
        "prefix_cache_hit_pct": round(cache_hit_pct, 1),
        "ts": now,
    }
    return result
