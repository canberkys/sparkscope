"""SSH-based metric collector using asyncssh with connection pooling."""

import asyncio
import asyncssh
import logging
import time
from pathlib import Path

logger = logging.getLogger("gb10.ssh")

METRIC_COMMAND = """
echo "---CPU_STAT---"; head -1 /proc/stat; \
echo "---LOADAVG---"; cat /proc/loadavg; \
echo "---THERMAL---"; for z in /sys/class/thermal/thermal_zone*/temp; do echo "$z: $(cat $z 2>/dev/null)"; done; \
echo "---MEMINFO---"; head -10 /proc/meminfo; \
echo "---DISKSTATS---"; grep nvme /proc/diskstats 2>/dev/null; \
echo "---DF---"; df -B1 /; \
echo "---NETDEV---"; cat /proc/net/dev; \
echo "---UPTIME---"; cat /proc/uptime; \
echo "---PROCCNT---"; ls /proc | grep -cE '^[0-9]+$'; \
echo "---ZOMBIES---"; ps -eo state 2>/dev/null | grep -c Z; \
echo "---GPU---"; nvidia-smi --query-gpu=utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,temperature.gpu,power.draw,power.limit,clocks.current.sm,clocks.current.memory --format=csv,noheader,nounits 2>/dev/null; \
echo "---GPUHEALTH---"; nvidia-smi --query-gpu=ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total,clocks_throttle_reasons.active,pcie.link.gen.current,persistence_mode --format=csv,noheader,nounits 2>/dev/null; \
echo "---GPUPROC---"; nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null; \
echo "---TOPCPU---"; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -10
""".strip()


class SSHPool:
    """Manages persistent SSH connections with reconnect logic."""

    def __init__(self, hosts: dict, timeout: int = 5, backoff: list[int] | None = None):
        self._hosts = hosts  # {name: {ssh_alias, display_name, ...}}
        self._timeout = timeout
        self._backoff = backoff or [1, 2, 5, 10, 30]
        self._connections: dict[str, asyncssh.SSHClientConnection] = {}
        self._retry_count: dict[str, int] = {}
        self._prev_cpu: dict[str, dict] = {}
        self._prev_disk: dict[str, dict] = {}
        self._prev_net: dict[str, dict] = {}
        self._online: dict[str, bool] = {h: False for h in hosts}

    @property
    def online_status(self) -> dict[str, bool]:
        return dict(self._online)

    async def connect(self, host_name: str):
        """Connect to a host using SSH config alias."""
        cfg = self._hosts[host_name]
        alias = cfg["ssh_alias"]
        try:
            conn = await asyncio.wait_for(
                asyncssh.connect(alias, known_hosts=None),
                timeout=self._timeout,
            )
            self._connections[host_name] = conn
            self._online[host_name] = True
            self._retry_count[host_name] = 0
            logger.info(f"Connected to {host_name} ({alias})")
        except Exception as e:
            self._online[host_name] = False
            retry = self._retry_count.get(host_name, 0)
            backoff = self._backoff[min(retry, len(self._backoff) - 1)]
            self._retry_count[host_name] = retry + 1
            logger.warning(f"Failed to connect to {host_name}: {e}. Retry in {backoff}s")
            await asyncio.sleep(backoff)

    async def ensure_connected(self, host_name: str):
        conn = self._connections.get(host_name)
        if conn is None or conn.is_closed():
            await self.connect(host_name)

    async def collect(self, host_name: str) -> tuple[dict, list[dict], list[dict]] | None:
        """Collect metrics from a host. Returns (metrics_dict, gpu_processes, top_processes) or None."""
        await self.ensure_connected(host_name)
        conn = self._connections.get(host_name)
        if conn is None or conn.is_closed():
            self._online[host_name] = False
            return None

        try:
            result = await asyncio.wait_for(
                conn.run(METRIC_COMMAND, check=False),
                timeout=self._timeout,
            )
            self._online[host_name] = True
            self._retry_count[host_name] = 0
            return self._parse_output(host_name, result.stdout or "")
        except Exception as e:
            logger.error(f"Collect failed for {host_name}: {e}")
            self._online[host_name] = False
            self._connections.pop(host_name, None)
            return None

    async def run_command(self, host_name: str, command: str) -> dict:
        """Run an arbitrary command and return result."""
        await self.ensure_connected(host_name)
        conn = self._connections.get(host_name)
        if conn is None or conn.is_closed():
            return {"exit_code": -1, "stdout": "", "stderr": "Not connected", "duration_ms": 0}

        t0 = time.monotonic()
        try:
            result = await asyncio.wait_for(
                conn.run(command, check=False),
                timeout=30,
            )
            duration = int((time.monotonic() - t0) * 1000)
            return {
                "exit_code": result.exit_status or 0,
                "stdout": result.stdout or "",
                "stderr": result.stderr or "",
                "duration_ms": duration,
            }
        except Exception as e:
            duration = int((time.monotonic() - t0) * 1000)
            return {"exit_code": -1, "stdout": "", "stderr": str(e), "duration_ms": duration}

    async def close_all(self):
        for name, conn in self._connections.items():
            try:
                conn.close()
            except Exception:
                pass
        self._connections.clear()

    # --- Parsing ---

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
        if len(parts) < 8:
            return {}
        # user, nice, system, idle, iowait, irq, softirq, steal
        vals = [int(x) for x in parts[1:8]]
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
        return {"cpu.temp_max_c": max(temps) if temps else 0}

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

        # diskstats for NVMe IOPS/throughput (delta)
        reads = writes = read_sectors = write_sectors = 0
        for line in diskstats.strip().split("\n"):
            parts = line.split()
            if len(parts) >= 14 and "nvme" in parts[2] and parts[2].endswith("0n1"):
                reads = int(parts[3])
                read_sectors = int(parts[5])
                writes = int(parts[7])
                write_sectors = int(parts[9])

        now_disk = {"reads": reads, "writes": writes, "read_sec": read_sectors, "write_sec": write_sectors, "ts": time.time()}
        prev = self._prev_disk.get(host)
        self._prev_disk[host] = now_disk

        if prev:
            dt = now_disk["ts"] - prev["ts"]
            if dt > 0:
                metrics["disk.read_iops"] = round((reads - prev["reads"]) / dt, 1)
                metrics["disk.write_iops"] = round((writes - prev["writes"]) / dt, 1)
                metrics["disk.read_mbps"] = round((read_sectors - prev["read_sec"]) * 512 / dt / 1e6, 2)
                metrics["disk.write_mbps"] = round((write_sectors - prev["write_sec"]) * 512 / dt / 1e6, 2)

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
                    "ts": time.time(),
                }

        metrics = {}
        prev_all = self._prev_net.get(host, {})

        for iface, cur in interfaces.items():
            if iface in ("lo",):
                continue
            prev = prev_all.get(iface)
            if prev:
                dt = cur["ts"] - prev["ts"]
                if dt > 0:
                    rx_mbps = (cur["rx_bytes"] - prev["rx_bytes"]) * 8 / dt / 1e6
                    tx_mbps = (cur["tx_bytes"] - prev["tx_bytes"]) * 8 / dt / 1e6
                    rx_errs = (cur["rx_errors"] - prev["rx_errors"]) / dt
                    tx_errs = (cur["tx_errors"] - prev["tx_errors"]) / dt
                    short = iface.replace("enp1s0f0np0", "link0").replace("enP2p1s0f0np0", "link1").replace("wlP9s9", "wifi")
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

    def _parse_gpu(self, data: str) -> dict:
        line = data.strip()
        if not line:
            return {}
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 10:
            return {}

        def safe_float(val):
            try:
                return float(val)
            except (ValueError, TypeError):
                return 0.0

        # For unified memory (GB10): mem_total/free/used may be [N/A]
        # Use system memory info instead when GPU memory is N/A
        result = {
            "gpu.util_pct": safe_float(parts[0]),
            "gpu.mem_util_pct": safe_float(parts[1]),
            "gpu.mem_total_mb": safe_float(parts[2]),
            "gpu.mem_free_mb": safe_float(parts[3]),
            "gpu.mem_used_mb": safe_float(parts[4]),
            "gpu.temp_c": safe_float(parts[5]),
            "gpu.power_draw_w": safe_float(parts[6]),
            "gpu.power_limit_w": safe_float(parts[7]),
            "gpu.sm_clock_mhz": safe_float(parts[8]),
            "gpu.mem_clock_mhz": safe_float(parts[9]),
        }
        return result

    def _parse_gpu_health(self, data: str) -> dict:
        """Parse GPU health: ECC, throttle reasons, PCIe gen, persistence."""
        line = data.strip()
        if not line:
            return {}
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            return {}

        def safe_int(val):
            try:
                return int(val)
            except (ValueError, TypeError):
                return 0

        def safe_throttle(val):
            # clocks_throttle_reasons.active is a hex bitmask, e.g. "0x0000000000000000"
            try:
                if isinstance(val, str) and val.startswith("0x"):
                    return int(val, 16)
                return int(val)
            except (ValueError, TypeError):
                return 0

        throttle_val = safe_throttle(parts[2])
        result = {
            "gpu.ecc_corrected": safe_int(parts[0]),
            "gpu.ecc_uncorrected": safe_int(parts[1]),
            "gpu.throttle_active": 1 if throttle_val != 0 else 0,
            "gpu.pcie_gen": safe_int(parts[3]),
            "gpu.persistence_mode": 1 if parts[4].lower() in ("enabled", "1") else 0,
        }
        return result

    def _parse_gpu_procs(self, data: str) -> list[dict]:
        procs = []
        for line in data.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                try:
                    procs.append({"pid": int(parts[0]), "name": parts[1], "mem_mb": int(parts[2])})
                except (ValueError, IndexError):
                    continue
        return procs

    def _parse_top_procs(self, data: str) -> list[dict]:
        procs = []
        for line in data.strip().split("\n"):
            parts = line.split(None, 4)
            if len(parts) >= 5:
                try:
                    procs.append({
                        "pid": int(parts[0]),
                        "user": parts[1],
                        "cpu_pct": float(parts[2]),
                        "mem_pct": float(parts[3]),
                        "command": parts[4],
                    })
                except (ValueError, IndexError):
                    continue
        return procs
