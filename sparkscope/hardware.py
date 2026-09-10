"""Hardware rule resolution and inventory merging; identities never derive from order."""

import re

from .config import DEFAULT_THRESHOLDS

GPU_METRIC = re.compile(r"^gpu\.(GPU-[A-Za-z0-9-]+)\.(.+)$")


def component_metric(metric):
    match = GPU_METRIC.fullmatch(metric)
    return (match[1], "gpu." + match[2]) if match else (None, metric)


def effective_rules(device_id, metrics, global_rules=None, hardware_rules=None):
    unconfigured = global_rules is None
    global_rules = DEFAULT_THRESHOLDS if global_rules is None else global_rules
    hardware_rules = hardware_rules or {}
    device = hardware_rules.get("devices", {}).get(device_id, {})
    profile = hardware_rules.get("profiles", {}).get(device.get("profile", ""), {})
    profile_metrics = profile.get("metrics", profile)
    stable = any(GPU_METRIC.fullmatch(key) for key in metrics)
    result = {}
    # Include global non-GPU rules even when absent, so missing samples reset counters.
    candidates = set(metrics) | {key for key in global_rules if not key.startswith("gpu.")}
    if not stable:
        candidates |= set(global_rules)
    for metric in candidates:
        component, canonical = component_metric(metric)
        if stable and metric.startswith("gpu.") and not component:
            continue
        sources = [("global", global_rules), ("profile", profile_metrics), ("device", device.get("metrics", {}))]
        if component:
            sources.append(("gpu", device.get("gpus", {}).get(component, {})))
        selected = None
        for source, rules in sources:
            if canonical in rules:
                if (
                    source == "global"
                    and unconfigured
                    and component
                    and canonical in ("gpu.temp_c", "gpu.power_draw_w")
                ):
                    selected = {"thresholds": None, "source": "unconfigured", "component_id": component}
                else:
                    selected = {"thresholds": rules[canonical], "source": source, "component_id": component}
        if selected is not None:
            result[metric] = selected
    return result


def merge_inventory(previous, discovered):
    """Retain known identities on discovery errors; explicitly mark removed GPUs."""
    result = {**previous, **discovered}
    status = discovered.get("capability_status", {}).get("gpu")
    if status == "unavailable" or (status == "unsupported" and not discovered.get("gpu_inventory_verified")):
        for field in ("gpus", "gpu", "gpu_names", "gpu_count", "capabilities"):
            if field in previous:
                result[field] = previous[field]
    else:
        current = discovered.get("gpus", [])
        identities = {gpu.get("uuid") for gpu in current}
        result["gpus"] = current + [
            {**gpu, "present": False}
            for gpu in previous.get("gpus", [])
            if gpu.get("uuid") and gpu["uuid"] not in identities
        ]
    return result
