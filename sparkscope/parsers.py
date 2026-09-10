"""Linux /proc and NVIDIA text parsers; no network or credential handling."""

import math
import re
import time

METRIC_COMMAND = """
echo "---CPU_STAT---"; head -1 /proc/stat; \
echo "---LOADAVG---"; cat /proc/loadavg; \
echo "---THERMAL---"; for z in /sys/class/thermal/thermal_zone*/temp; do echo "$z: $(cat $z 2>/dev/null)"; done; \
echo "---MEMINFO---"; cat /proc/meminfo; \
echo "---DISKSTATS---"; cat /proc/diskstats 2>/dev/null; \
echo "---DF---"; df -B1 /; \
echo "---NETDEV---"; cat /proc/net/dev; \
echo "---UPTIME---"; cat /proc/uptime; \
echo "---PROCCNT---"; ls /proc | grep -cE '^[0-9]+$'; \
echo "---ZOMBIES---"; ps -eo state 2>/dev/null | grep -c Z; \
echo "---GPU---"; nvidia-smi --query-gpu=uuid,utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,temperature.gpu,power.draw,power.limit,clocks.current.sm,clocks.current.memory --format=csv,noheader,nounits 2>/dev/null; \
echo "---GPUHEALTH---"; nvidia-smi --query-gpu=uuid,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active,pcie.link.gen.current,persistence_mode --format=csv,noheader,nounits 2>/dev/null; \
echo "---GPUPROC---"; nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null; \
echo "---TOPCPU---"; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -10
""".strip()


class MetricParser:
    def __init__(self, *args, **kwargs):
        self._prev_cpu = {}
        self._prev_disk = {}
        self._prev_net = {}

    def _parse_output(self, host: str, output: str) -> tuple[dict, list[dict], list[dict]]:
        sections = {}
        current_section = None
        current_lines = []

        for line in output.split("\n"):
            if line.startswith("---") and line.endswith("---"):
                if current_section:
                    sections[current_section] = "\n".join(current_lines)
                current_section = line.strip("-")
                current_lines = []
            else:
                current_lines.append(line)
        if current_section:
            sections[current_section] = "\n".join(current_lines)

        metrics = {}
        gpu_procs = []
        top_procs = []

        # CPU
        cpu_data = self._parse_cpu(host, sections.get("CPU_STAT", ""))
        metrics.update(cpu_data)

        # Load
        load_data = self._parse_loadavg(sections.get("LOADAVG", ""))
        metrics.update(load_data)

        # Thermal
        thermal = self._parse_thermal(sections.get("THERMAL", ""))
        metrics.update(thermal)

        # Memory
        mem = self._parse_meminfo(sections.get("MEMINFO", ""))
        metrics.update(mem)

        # Disk
        disk = self._parse_disk(host, sections.get("DISKSTATS", ""), sections.get("DF", ""))
        metrics.update(disk)

        # Network
        net = self._parse_netdev(host, sections.get("NETDEV", ""))
        metrics.update(net)

        # Uptime
        uptime = self._parse_uptime(sections.get("UPTIME", ""))
        metrics.update(uptime)

        # Process count
        proccnt = sections.get("PROCCNT", "0").strip()
        metrics["system.process_count"] = int(proccnt) if proccnt.isdigit() else 0

        zombies = sections.get("ZOMBIES", "0").strip()
        metrics["system.zombie_count"] = int(zombies) if zombies.isdigit() else 0

        # GPU
        gpu = self._parse_gpu(sections.get("GPU", ""))
        metrics.update(gpu)

        # GPU health (ECC, throttle)
        gpu_health = self._parse_gpu_health(sections.get("GPUHEALTH", ""))
        metrics.update(gpu_health)

        # GPU processes
        gpu_procs = self._parse_gpu_procs(sections.get("GPUPROC", ""))

        # Top CPU processes
        top_procs = self._parse_top_procs(sections.get("TOPCPU", ""))

        return metrics, gpu_procs, top_procs

    def _parse_cpu(self, host: str, data: str) -> dict:
        line = data.strip()
        if not line.startswith("cpu"):
            return {}
        parts = line.split()
        if len(parts) < 9:
            return {}
        # user, nice, system, idle, iowait, irq, softirq, steal
        vals = [int(x) for x in parts[1:9]]
        total = sum(vals)
        idle = vals[3] + vals[4]  # idle + iowait

        prev = self._prev_cpu.get(host)
        self._prev_cpu[host] = {"total": total, "idle": idle}

        if prev:
            d_total = total - prev["total"]
            d_idle = idle - prev["idle"]
            usage = ((d_total - d_idle) / d_total * 100) if d_total > 0 else 0
        else:
            usage = 0

        return {"cpu.usage_pct": round(usage, 1)}

    def _parse_loadavg(self, data: str) -> dict:
        parts = data.strip().split()
        if len(parts) < 3:
            return {}
        return {
            "cpu.load_1m": float(parts[0]),
            "cpu.load_5m": float(parts[1]),
            "cpu.load_15m": float(parts[2]),
        }

    def _parse_thermal(self, data: str) -> dict:
        temps = []
        for line in data.strip().split("\n"):
            if ":" in line:
                try:
                    val = int(line.split(":")[-1].strip()) / 1000
                    temps.append(val)
                except (ValueError, IndexError):
                    continue
        return {"cpu.temp_max_c": max(temps)} if temps else {}

    def _parse_meminfo(self, data: str) -> dict:
        info = {}
        for line in data.strip().split("\n"):
            if ":" in line:
                key, val = line.split(":", 1)
                num = val.strip().split()[0]
                try:
                    info[key.strip()] = int(num)
                except ValueError:
                    continue

        if "MemTotal" not in info:
            return {}
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", 0)
        free = info.get("MemFree", 0)
        buffers = info.get("Buffers", 0)
        cached = info.get("Cached", 0)
        swap_total = info.get("SwapTotal", 0)
        swap_free = info.get("SwapFree", 0)

        used_pct = ((total - avail) / total * 100) if total > 0 else 0

        return {
            "memory.total_kb": total,
            "memory.free_kb": free,
            "memory.available_kb": avail,
            "memory.buffers_kb": buffers,
            "memory.cached_kb": cached,
            "memory.used_pct": round(used_pct, 1),
            "memory.swap_total_kb": swap_total,
            "memory.swap_free_kb": swap_free,
        }

    def _parse_disk(self, host: str, diskstats: str, df_out: str) -> dict:
        metrics = {}

        # df for root partition
        for line in df_out.strip().split("\n")[1:]:
            parts = line.split()
            if len(parts) >= 6 and parts[5] == "/":
                total = int(parts[1])
                used = int(parts[2])
                metrics["disk.root_total_bytes"] = total
                metrics["disk.root_used_bytes"] = used
                metrics["disk.root_used_pct"] = round(used / total * 100, 1) if total > 0 else 0
                break

        # Whole leaf disks only: partitions and stacked devices would double-count I/O.
        disks = {}
        for line in diskstats.strip().split("\n"):
            parts = line.split()
            if len(parts) >= 14 and re.fullmatch(r"(?:nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)", parts[2]):
                disks[parts[2]] = {
                    "reads": int(parts[3]),
                    "writes": int(parts[7]),
                    "read_sec": int(parts[5]),
                    "write_sec": int(parts[9]),
                    "ts": time.monotonic(),
                }
        previous = self._prev_disk.get(host, {})
        self._prev_disk[host] = disks
        totals = {}
        for disk, cur in disks.items():
            prev = previous.get(disk)
            if not isinstance(prev, dict):
                continue
            dt = cur["ts"] - prev["ts"]
            if dt <= 0 or any(cur[k] < prev[k] for k in ("reads", "writes", "read_sec", "write_sec")):
                continue
            rates = {
                "read_iops": (cur["reads"] - prev["reads"]) / dt,
                "write_iops": (cur["writes"] - prev["writes"]) / dt,
                "read_mbps": (cur["read_sec"] - prev["read_sec"]) * 512 / dt / 1e6,
                "write_mbps": (cur["write_sec"] - prev["write_sec"]) * 512 / dt / 1e6,
            }
            for key, value in rates.items():
                metrics[f"disk.{disk}.{key}"] = round(value, 3)
                totals[key] = totals.get(key, 0) + value
        metrics.update({f"disk.{key}": round(value, 3) for key, value in totals.items()})

        return metrics

    def _parse_netdev(self, host: str, data: str) -> dict:
        interfaces = {}
        for line in data.strip().split("\n"):
            if ":" not in line or "Inter" in line or "face" in line:
                continue
            iface, rest = line.split(":", 1)
            iface = iface.strip()
            parts = rest.split()
            if len(parts) >= 16:
                interfaces[iface] = {
                    "rx_bytes": int(parts[0]),
                    "rx_errors": int(parts[2]),
                    "tx_bytes": int(parts[8]),
                    "tx_errors": int(parts[10]),
                    "ts": time.monotonic(),
                }

        metrics = {}
        prev_all = self._prev_net.get(host, {})

        for iface, cur in interfaces.items():
            if iface in ("lo",):
                continue
            prev = prev_all.get(iface)
            if prev:
                dt = cur["ts"] - prev["ts"]
                if dt > 0 and all(cur[k] >= prev[k] for k in ("rx_bytes", "tx_bytes", "rx_errors", "tx_errors")):
                    rx_mbps = (cur["rx_bytes"] - prev["rx_bytes"]) * 8 / dt / 1e6
                    tx_mbps = (cur["tx_bytes"] - prev["tx_bytes"]) * 8 / dt / 1e6
                    rx_errs = (cur["rx_errors"] - prev["rx_errors"]) / dt
                    tx_errs = (cur["tx_errors"] - prev["tx_errors"]) / dt
                    short = iface
                    metrics[f"network.{short}_rx_mbps"] = round(rx_mbps, 3)
                    metrics[f"network.{short}_tx_mbps"] = round(tx_mbps, 3)
                    metrics[f"network.{short}_rx_errors"] = round(rx_errs, 1)
                    metrics[f"network.{short}_tx_errors"] = round(tx_errs, 1)

        self._prev_net[host] = interfaces
        return metrics

    def _parse_uptime(self, data: str) -> dict:
        parts = data.strip().split()
        if parts:
            try:
                return {"system.uptime_seconds": float(parts[0])}
            except ValueError:
                pass
        return {}

    @staticmethod
    def _gpu_rows(data: str, fields: tuple, convert, include_missing=False) -> dict:
        # NVIDIA emits one row per GPU. Never flatten rows into a device summary.
        rows = [line for line in data.splitlines() if line.strip()]
        result = {}
        for index, line in enumerate(rows):
            parts = [part.strip() for part in line.split(",")]
            identity = None
            if len(parts) == len(fields) + 1:
                identity, parts = parts[0], parts[1:]
                # Never attach a UUID-less production sample to a changing index.
                if not re.fullmatch(r"GPU-[A-Za-z0-9-]+", identity):
                    continue
            if len(parts) != len(fields):
                continue
            for field, raw in zip(fields, parts):
                value = convert(field, raw)
                if value is not None or include_missing:
                    result[f"gpu.{identity or index}.{field}"] = value
                    if identity is None and len(rows) == 1:
                        result[f"gpu.{field}"] = value
        return result

    def _parse_gpu(self, data: str) -> dict:
        def number(field, raw):
            try:
                value = float(raw)
                return value if math.isfinite(value) else None
            except ValueError:
                return None

        return self._gpu_rows(
            data,
            (
                "util_pct",
                "mem_util_pct",
                "mem_total_mb",
                "mem_free_mb",
                "mem_used_mb",
                "temp_c",
                "power_draw_w",
                "power_limit_w",
                "sm_clock_mhz",
                "mem_clock_mhz",
            ),
            number,
            include_missing=True,
        )

    def _parse_gpu_health(self, data: str) -> dict:
        def number(field, raw):
            if field == "persistence_mode":
                return {"enabled": 1, "disabled": 0, "1": 1, "0": 0}.get(raw.lower())
            try:
                value = int(raw, 16) if raw.lower().startswith("0x") else int(raw)
            except ValueError:
                return None
            if field == "throttle_active":
                # GPU idle (bit 0) alone is not a throttling fault.
                return int(bool(value & ~0x1))
            return value

        return self._gpu_rows(
            data,
            ("ecc_corrected", "ecc_uncorrected", "throttle_active", "pcie_gen", "persistence_mode"),
            number,
        )

    def _parse_gpu_procs(self, data: str) -> list[dict]:
        procs = []
        for line in data.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            identity = parts.pop(0) if len(parts) == 4 else None
            if len(parts) >= 3:
                try:
                    procs.append(
                        {"pid": int(parts[0]), "name": parts[1], "mem_mb": int(parts[2]), "gpu_uuid": identity}
                    )
                except (ValueError, IndexError):
                    continue
        return procs

    def _parse_top_procs(self, data: str) -> list[dict]:
        procs = []
        for line in data.strip().split("\n"):
            parts = line.split(None, 4)
            if len(parts) >= 5:
                try:
                    procs.append(
                        {
                            "pid": int(parts[0]),
                            "user": parts[1],
                            "cpu_pct": float(parts[2]),
                            "mem_pct": float(parts[3]),
                            "command": parts[4],
                        }
                    )
                except (ValueError, IndexError):
                    continue
        return procs
