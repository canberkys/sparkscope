"""Read-only runtime adapters. HTTP travels over the trusted device's SSH connection."""

import asyncio
import json
import math
import re
import time

PROM_KEYS = {
    "vllm:num_requests_running": "requests_running",
    "vllm:num_requests_waiting": "requests_waiting",
    "vllm:kv_cache_usage_perc": "kv_cache_ratio",
    "vllm:gpu_cache_usage_perc": "kv_cache_ratio",
    "vllm:prompt_tokens_total": "prompt_tokens_total",
    "vllm:generation_tokens_total": "generation_tokens_total",
    "vllm:prefix_cache_queries_total": "prefix_queries",
    "vllm:prefix_cache_hits_total": "prefix_hits",
    "llamacpp:tokens_predicted_total": "generation_tokens_total",
    "llamacpp:prompt_tokens_total": "prompt_tokens_total",
    "llamacpp:requests_processing": "requests_running",
    "llamacpp:requests_deferred": "requests_waiting",
}


def prometheus(raw):
    out = {}
    gauges = {}
    for line in raw.splitlines():
        match = re.match(r"^([\w:]+)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+[^\s]+)?$", line)
        if not match or match[1] not in PROM_KEYS:
            continue
        try:
            value = float(match[2])
        except ValueError:
            continue
        if not math.isfinite(value):
            continue
        key = PROM_KEYS[match[1]]
        if key == "kv_cache_ratio":
            gauges.setdefault(key, []).append(value)
        else:
            out[key] = out.get(key, 0) + value
    for key, values in gauges.items():
        out["kv_cache_pct"] = sum(values) / len(values) * 100
    return out


async def http_on(transport, conn, port, path, api_key=""):
    # Credentials go through stdin, not the remote process argument list.
    cfg = "url = " + json.dumps(f"http://127.0.0.1:{int(port)}{path}") + "\n"
    if api_key:
        cfg += "header = " + json.dumps("Authorization: Bearer " + api_key) + "\n"
    r = await transport.run_on(conn, "curl --silent --show-error --fail --max-time 3 --config -", 5, cfg)
    if r["exit_code"] != 0:
        return None
    return r["stdout"]


def as_json(raw):
    try:
        return json.loads(raw) if raw else None
    except (ValueError, TypeError):
        return None


def metric_capabilities(provider, metrics, previous=None):
    """Remember observed endpoint capabilities through outages and counter warm-up."""
    if provider == "ollama":
        return []
    previous = previous or {}
    names = set(previous.get("supported_metrics", [])) | set(previous.get("metrics", {})) | set(metrics)
    for total, rate in [
        ("generation_tokens_total", "gen_tokens_per_s"),
        ("prompt_tokens_total", "prompt_tokens_per_s"),
    ]:
        if total in names:
            names.add(rate)
    if "prefix_queries" in names and "prefix_hits" in names:
        names.add("prefix_cache_hit_pct")
    return sorted(names)


async def collect_service(transport, conn, provider, port, path="", api_key="", prev=None):
    ts = time.time()
    warnings = []
    metrics = {}
    models = []
    if provider == "ollama":
        tags, ps = await asyncio.gather(
            http_on(transport, conn, port, path + "/api/tags", api_key),
            http_on(transport, conn, port, path + "/api/ps", api_key),
        )
        installed = as_json(tags)
        loaded = as_json(ps)
        if not isinstance(installed, dict):
            return {
                "status": "unavailable",
                "models": [],
                "metrics": {},
                "warnings": ["Model endpoint unavailable or authentication required."],
                "supported_metrics": metric_capabilities(provider, {}, prev),
            }
        loaded_names = {m.get("name"): m for m in (loaded or {}).get("models", [])}
        entries = {m.get("name"): m for m in installed.get("models", [])}
        entries.update(loaded_names)
        models = [
            {
                "name": name,
                "state": "loaded" if name in loaded_names else "installed",
                "context_length": m.get("context_length"),
                "size_bytes": m.get("size"),
            }
            for name, m in entries.items()
            if name
        ]
        if loaded is None:
            warnings.append("Running-model endpoint unavailable; load state is unknown.")
        if loaded is None:
            for m in models:
                m["state"] = "unknown"
    else:
        raw_models, raw_metrics = await asyncio.gather(
            http_on(transport, conn, port, path + "/v1/models", api_key),
            http_on(transport, conn, port, path + "/metrics", api_key),
        )
        model_data = as_json(raw_models)
        if not isinstance(model_data, dict) or "data" not in model_data:
            return {
                "status": "unavailable",
                "models": [],
                "metrics": {},
                "warnings": ["Model endpoint unavailable or authentication required."],
                "supported_metrics": metric_capabilities(provider, {}, prev),
            }
        models = [
            {"name": m.get("id", "Unknown"), "state": "serving", "context_length": m.get("max_model_len")}
            for m in model_data["data"]
        ]
        metrics = prometheus(raw_metrics or "")
        if raw_metrics is None:
            warnings.append("Metrics unavailable. Enable the runtime metrics endpoint if supported.")
    if prev and prev.get("status") == "online":
        dt = ts - prev.get("ts", ts)
        if 0 < dt < 120:
            for total, rate in [
                ("generation_tokens_total", "gen_tokens_per_s"),
                ("prompt_tokens_total", "prompt_tokens_per_s"),
            ]:
                old = prev.get("metrics", {}).get(total)
                new = metrics.get(total)
                if old is not None and new is not None and new >= old:
                    metrics[rate] = round((new - old) / dt, 2)
    if metrics.get("prefix_queries", 0) > 0:
        metrics["prefix_cache_hit_pct"] = 100 * metrics.get("prefix_hits", 0) / metrics["prefix_queries"]
    return {
        "status": "online",
        "models": models,
        "metrics": metrics,
        "supported_metrics": metric_capabilities(provider, metrics, prev),
        "warnings": warnings,
        "ts": ts,
    }


async def discover(transport, conn):
    result = await transport.run_on(
        conn,
        "docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null; echo '---LISTEN---'; ss -ltnpH 2>/dev/null",
        8,
    )
    raw = result["stdout"]
    candidates = {(8000, "vllm"), (11434, "ollama"), (8080, "llama.cpp")}
    for line in raw.splitlines():
        lower = line.lower()
        provider = next(
            (p for term, p in [("vllm", "vllm"), ("ollama", "ollama"), ("llama", "llama.cpp")] if term in lower), None
        )
        if provider:
            for port in re.findall(r":(\d+)(?:->|\s)", line):
                candidates.add((int(port), provider))
    candidates = sorted(candidates)[:12]
    services = []
    # Bounded probes; one failed endpoint does not prevent other discovery.
    for port, provider in candidates:
        data = await collect_service(transport, conn, provider, port)
        if data["status"] == "online":
            if provider == "vllm":
                raw = await http_on(transport, conn, port, "/metrics")
                if raw and "llamacpp:" in raw:
                    provider = "llama.cpp"
            if not any(s["port"] == port for s in services):
                services.append({"provider": provider, "port": port, "path": "", "data": data})
    return services
