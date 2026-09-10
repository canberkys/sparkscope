"""Hardware parsing without SSH access or a database."""

import asyncio

import pytest

from sparkscope.parsers import MetricParser
from sparkscope.ssh import Transport


def test_cpu_only_has_no_invented_gpu():
    metrics, _, _ = MetricParser()._parse_output(
        "cpu-host", "---MEMINFO---\nMemTotal: 1000 kB\nMemAvailable: 250 kB\n---GPU---\n---GPUHEALTH---\n"
    )
    assert metrics["memory.used_pct"] == 75
    assert not any(key.startswith("gpu.") for key in metrics)


def test_single_gpu_preserves_aliases_and_unsupported_is_absent():
    parser = MetricParser()
    metrics = parser._parse_gpu("40, 20, [N/A], [N/A], [N/A], 50, nan, inf, 1000, 1000")
    assert metrics["gpu.util_pct"] == metrics["gpu.0.util_pct"] == 40
    assert metrics["gpu.mem_total_mb"] is None
    assert metrics["gpu.power_draw_w"] is None
    assert metrics["gpu.power_limit_w"] is None
    health = parser._parse_gpu_health("[N/A], [Not Supported], 0x1, 4, Enabled")
    assert health["gpu.pcie_gen"] == 4
    assert health["gpu.throttle_active"] == 0
    assert "gpu.ecc_corrected" not in health


def test_multiple_gpus_are_independent_without_ambiguous_aliases():
    parser = MetricParser()
    metrics = parser._parse_gpu(
        "10, 20, 24000, 22000, 2000, 45, 60, 300, 1000, 2000\n90, 80, 48000, 8000, 40000, 80, 250, 350, 1500, 2500"
    )
    assert metrics["gpu.0.util_pct"] == 10
    assert metrics["gpu.1.util_pct"] == 90
    assert metrics["gpu.1.mem_total_mb"] == 48000
    assert "gpu.util_pct" not in metrics
    health = parser._parse_gpu_health("0, 0, 0x1, 4, Enabled\n2, 1, 0x4, [N/A], [N/A]")
    assert health["gpu.0.throttle_active"] == 0
    assert health["gpu.1.throttle_active"] == 1
    assert health["gpu.1.ecc_uncorrected"] == 1
    assert "gpu.1.pcie_gen" not in health
    assert "gpu.ecc_uncorrected" not in health


def disk_line(name, count):
    return f"8 0 {name} {count} 0 {count} 0 {count} 0 {count} 0 0 0 0"


def test_leaf_disk_rates_exclude_partitions_and_stacked_aliases(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("sparkscope.parsers.time.monotonic", lambda: clock[0])
    parser = MetricParser()
    included = ["nvme0n1", "sda", "sdaa", "vda", "xvda", "mmcblk0"]
    excluded = ["nvme0n1p1", "sda1", "vda1", "xvda1", "mmcblk0p1", "mmcblk0boot0", "dm-0", "md0", "loop0", "nvme0c0n1"]
    devices = included + excluded
    assert parser._parse_disk("host", "\n".join(disk_line(name, 100) for name in devices), "") == {}
    clock[0] += 2
    metrics = parser._parse_disk("host", "\n".join(disk_line(name, 120) for name in devices), "")
    assert metrics["disk.read_iops"] == len(included) * 10
    assert metrics["disk.read_mbps"] == round(len(included) * 10 * 512 / 1e6, 3)
    for name in included:
        assert metrics[f"disk.{name}.write_iops"] == 10
    for name in excluded:
        assert f"disk.{name}.write_iops" not in metrics
    clock[0] += 2
    # Reboot / reset cannot emit negative rates.
    assert parser._parse_disk("host", disk_line("sda", 1), "") == {}


@pytest.mark.parametrize(
    "rows,names",
    [
        ("", []),
        ("NVIDIA GB10, 580.0\n", ["NVIDIA GB10"]),
        ("NVIDIA A100, 580.0\nNVIDIA L40, 580.0\n", ["NVIDIA A100", "NVIDIA L40"]),
    ],
)
def test_discovery_retains_all_nvidia_names(rows, names):
    class DiscoveryTransport(Transport):
        async def run_on(self, conn, command, timeout=30, stdin=None):
            assert "| head -1" not in command
            return {"stdout": f"host\n6.0\nLinux\n{rows}---NETWORK---\n[]\n---DISKS---\n{{}}"}

    info = asyncio.run(DiscoveryTransport(None).info_on(None))
    assert info["gpu_names"] == names
    assert info["gpu_count"] == len(names)
    assert info["capabilities"]["gpu"] == bool(names)
    assert all(name in info["gpu"] for name in names)


def test_uuid_metrics_survive_reordering_and_reject_missing_identity():
    parser = MetricParser()
    a = "GPU-aaa, 10, 20, 100, 80, 20, 40, 30, 100, 1000, 1000"
    b = "GPU-bbb, 90, 20, 100, 80, 20, 80, 30, 100, 1000, 1000"
    assert parser._parse_gpu(a + "\n" + b) == parser._parse_gpu(b + "\n" + a)
    assert parser._parse_gpu(a)["gpu.GPU-aaa.util_pct"] == 10
    assert "gpu.util_pct" not in parser._parse_gpu(a)
    assert parser._parse_gpu(a.replace("GPU-aaa", "[N/A]")) == {}
    assert parser._parse_gpu_health("GPU-bbb, 0, 1, 0x4, 4, Enabled")["gpu.GPU-bbb.ecc_uncorrected"] == 1


def test_inventory_preserves_identity_on_error_and_marks_removal():
    from sparkscope.hardware import merge_inventory

    previous = {"cluster_name": "a", "gpus": [{"uuid": "GPU-a", "present": True}], "gpu_count": 1}
    failed = merge_inventory(previous, {"capability_status": {"gpu": "unavailable"}, "gpus": []})
    assert failed["gpus"] == previous["gpus"] and failed["gpu_count"] == 1
    removed = merge_inventory(
        previous,
        {"capability_status": {"gpu": "unsupported"}, "gpus": [], "gpu_count": 0, "gpu_inventory_verified": True},
    )
    assert removed["gpus"][0]["present"] is False
    assert removed["cluster_name"] == "a"


def test_hardware_rules_precedence_disable_and_alias_deduplication():
    from sparkscope.hardware import effective_rules

    config = {
        "profiles": {"h200": {"metrics": {"gpu.temp_c": [70, 80]}}},
        "devices": {
            "node": {
                "profile": "h200",
                "metrics": {"gpu.temp_c": [75, 85]},
                "gpus": {"GPU-a": {"gpu.temp_c": None}, "GPU-b": {"gpu.temp_c": [80, 90]}},
            }
        },
    }
    metrics = {"gpu.GPU-a.temp_c": 95, "gpu.GPU-b.temp_c": 85, "gpu.temp_c": 95, "gpu.0.temp_c": 95}
    rules = effective_rules("node", metrics, {"gpu.temp_c": [60, 70]}, config)
    assert set(rules) == {"gpu.GPU-a.temp_c", "gpu.GPU-b.temp_c"}
    assert rules["gpu.GPU-a.temp_c"]["thresholds"] is None
    assert rules["gpu.GPU-b.temp_c"] == {"thresholds": [80, 90], "source": "gpu", "component_id": "GPU-b"}
    assert effective_rules("other", metrics, {}) == {}


async def test_gpu_incidents_and_events_are_isolated(env):
    from sqlalchemy import select

    from sparkscope.alerts import AlertEngine
    from sparkscope.models import Alert, FleetEvent

    app, _, _ = env
    engine = AlertEngine()
    thresholds = {"gpu.temp_c": [80, 90]}
    # Only UUID keyed metrics can open incidents; legacy aliases are ignored.
    for i in range(3):
        async with app.state.db.session() as s:
            await engine.evaluate(
                s, "node", {"gpu.GPU-a.temp_c": 95, "gpu.GPU-b.temp_c": 85, "gpu.temp_c": 95}, i, thresholds
            )
    async with app.state.db.session() as s:
        alerts = (await s.scalars(select(Alert))).all()
        assert len(alerts) == 2
        assert {a.component_id for a in alerts} == {"GPU-a", "GPU-b"}
    for i in range(3):
        async with app.state.db.session() as s:
            await engine.evaluate(s, "node", {"gpu.GPU-a.temp_c": 30, "gpu.GPU-b.temp_c": 95}, i + 3, thresholds)
    async with app.state.db.session() as s:
        active = (await s.scalars(select(Alert).where(Alert.resolved_at.is_(None)))).all()
        assert len(active) == 1 and active[0].component_id == "GPU-b" and active[0].severity == "critical"
        kinds = [e.kind for e in (await s.scalars(select(FleetEvent))).all()]
        assert kinds.count("alarm.open") == 2
        assert kinds.count("alarm.resolve") == kinds.count("alarm.escalate") == 1


async def test_cpu_only_collector_is_online(env):
    from conftest import onboard

    from sparkscope.models import Device

    app, client, transport = env
    device = await onboard(client)

    async def cpu_only(_):
        return {"metrics": {"memory.total_kb": 1024, "cpu.usage_pct": 20}, "gpu_procs": [], "top_procs": []}

    transport.system = cpu_only
    async with app.state.db.session() as s:
        row = await s.get(Device, device["id"])
        row.info = {"capability_status": {"gpu": "unsupported"}}
    await app.state.collector.poll_system(row)
    async with app.state.db.session() as s:
        assert (await s.get(Device, row.id)).status == "online"
    assert app.state.collector.capacities == {"system": 10, "services": 6, "slow": 4}


def test_new_gpu_temperature_and_power_require_configured_limits():
    from sparkscope.hardware import effective_rules

    metrics = {"gpu.GPU-a.temp_c": 95, "gpu.GPU-a.power_draw_w": 500}
    rules = effective_rules("node", metrics)
    assert all(
        rule["thresholds"] is None and rule["source"] == "unconfigured"
        for key, rule in rules.items()
        if key.startswith("gpu.")
    )
    saved = effective_rules("node", metrics, {"gpu.temp_c": [80, 90]})
    assert saved["gpu.GPU-a.temp_c"]["thresholds"] == [80, 90]
    assert effective_rules("node", {"gpu.temp_c": 95})["gpu.temp_c"]["thresholds"] == [80, 90]


def test_missing_collection_tool_does_not_retire_known_gpus():
    from sparkscope.hardware import merge_inventory

    previous = {"gpus": [{"uuid": "GPU-a", "present": True}], "gpu_count": 1, "capabilities": {"gpu": True}}
    missing_tool = {
        "capability_status": {"gpu": "unsupported"},
        "gpu_inventory_verified": False,
        "gpus": [],
        "gpu_count": 0,
        "capabilities": {"gpu": False},
    }
    result = merge_inventory(previous, missing_tool)
    assert result["gpus"] == previous["gpus"]
    assert result["gpu_count"] == 1 and result["capabilities"]["gpu"] is True
    assert result["capability_status"]["gpu"] == "unsupported"
    assert result["gpu_inventory_verified"] is False
