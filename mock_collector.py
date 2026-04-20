"""Mock data generator for demo mode — simulates 2x GB10 cluster.

Used when DEMO_MODE=1 or config.demo_mode=true. Produces realistic metric
patterns (sinusoidal CPU/GPU load, stable voltage, GPU power correlated with
utilization, occasional inference bursts) so visitors can explore the UI
without needing real hardware.
"""

import math
import random
import time
from typing import Optional


class MockState:
    """Per-host mock state with deterministic but evolving values."""

    def __init__(self, host_name: str, seed: int):
        self.host_name = host_name
        self.rng = random.Random(seed)
        self.start_time = time.time()

        # Previous counter values (for monotonic increasing metrics)
        self.total_prompt_tokens = self.rng.randint(2000, 50000)
        self.total_gen_tokens = self.rng.randint(8000, 200000)
        self.prefix_cache_queries = self.rng.randint(500, 5000)
        self.prefix_cache_hits = int(self.prefix_cache_queries * 0.3)
        self.disk_reads = self.rng.randint(50000, 200000)
        self.disk_writes = self.rng.randint(30000, 150000)
        self.net_rx = self.rng.randint(1_000_000_000, 10_000_000_000)
        self.net_tx = self.rng.randint(500_000_000, 5_000_000_000)
        self.boot_time = time.time() - self.rng.randint(3600, 86400 * 3)

    def tick(self) -> dict:
        """Produce one poll's worth of metrics."""
        t = time.time() - self.start_time

        # CPU: sinusoidal base + noise, different phase per host
        phase = 0 if self.host_name == "neo" else math.pi / 2
        cpu_base = 20 + 15 * math.sin(t / 40 + phase)
        cpu_usage = max(1, min(99, cpu_base + self.rng.gauss(0, 3)))

        # GPU: bursts of activity (15% of the time high load), else idle
        is_inference_active = (int(t / 30) % 7) < 1  # burst every ~3 min
        if is_inference_active:
            gpu_util = max(60, min(99, 85 + self.rng.gauss(0, 8)))
            gpu_power = 180 + self.rng.gauss(0, 15)
        else:
            gpu_util = max(0, self.rng.gauss(2, 2))
            gpu_power = 5 + self.rng.gauss(0, 2)

        # Thermals correlate with utilization
        cpu_temp = 45 + cpu_usage * 0.4 + self.rng.gauss(0, 1)
        gpu_temp = 42 + gpu_util * 0.3 + self.rng.gauss(0, 1)

        # Voltage: stable ~230V with tiny drift
        voltage = 229.5 + self.rng.gauss(0, 0.3)
        _ = voltage  # unused in Morpheus metrics (energy dashboard)

        # Update counters (delta over 2 seconds)
        poll_interval = 2.0
        self.disk_reads += self.rng.randint(0, 50)
        self.disk_writes += self.rng.randint(0, 30)
        self.net_rx += self.rng.randint(10_000, 500_000)
        self.net_tx += self.rng.randint(5_000, 200_000)

        if is_inference_active:
            gen_tokens_this_tick = int(self.rng.uniform(80, 120) * poll_interval)
            prompt_tokens_this_tick = int(self.rng.uniform(50, 200))
        else:
            gen_tokens_this_tick = 0
            prompt_tokens_this_tick = 0
        self.total_gen_tokens += gen_tokens_this_tick
        self.total_prompt_tokens += prompt_tokens_this_tick
        if prompt_tokens_this_tick > 0:
            self.prefix_cache_queries += 1
            if self.rng.random() < 0.3:
                self.prefix_cache_hits += 1

        gen_tokens_per_s = gen_tokens_this_tick / poll_interval

        metrics = {
            "cpu.usage_pct": round(cpu_usage, 1),
            "cpu.load_1m": round(cpu_usage / 25, 2),
            "cpu.load_5m": round(cpu_usage / 28, 2),
            "cpu.load_15m": round(cpu_usage / 32, 2),
            "cpu.temp_max_c": round(cpu_temp, 1),
            "memory.total_kb": 127_535_936,
            "memory.free_kb": 100_000_000 - int(gpu_power * 10000),
            "memory.available_kb": 110_000_000 - int(gpu_power * 8000),
            "memory.buffers_kb": 368_548,
            "memory.cached_kb": 3_891_420 + self.rng.randint(-100000, 100000),
            "memory.used_pct": round(15 + gpu_power / 10, 1),
            "memory.swap_total_kb": 0,
            "memory.swap_free_kb": 0,
            "disk.root_total_bytes": 3_922_556_002_304,
            "disk.root_used_bytes": 40_634_650_624 + int(t * 100),
            "disk.root_used_pct": 1.0,
            "disk.read_iops": round(self.rng.uniform(0, 5), 1) if is_inference_active else 0,
            "disk.write_iops": round(self.rng.uniform(0, 3), 1) if is_inference_active else 0,
            "disk.read_mbps": round(self.rng.uniform(0, 1.5), 2) if is_inference_active else 0,
            "disk.write_mbps": round(self.rng.uniform(0, 0.8), 2) if is_inference_active else 0,
            "network.wifi_rx_mbps": round(self.rng.uniform(0, 0.5), 3),
            "network.wifi_tx_mbps": round(self.rng.uniform(0, 0.2), 3),
            "network.wifi_rx_errors": 0,
            "network.wifi_tx_errors": 0,
            "network.link0_rx_mbps": round(self.rng.uniform(0, 2) if is_inference_active else 0, 3),
            "network.link0_tx_mbps": round(self.rng.uniform(0, 2) if is_inference_active else 0, 3),
            "network.link0_rx_errors": 0,
            "network.link0_tx_errors": 0,
            "network.link1_rx_mbps": round(self.rng.uniform(0, 1) if is_inference_active else 0, 3),
            "network.link1_tx_mbps": round(self.rng.uniform(0, 1) if is_inference_active else 0, 3),
            "network.link1_rx_errors": 0,
            "network.link1_tx_errors": 0,
            "system.uptime_seconds": time.time() - self.boot_time,
            "system.process_count": 500 + self.rng.randint(-10, 10),
            "system.zombie_count": 0,
            "gpu.util_pct": round(gpu_util, 1),
            "gpu.mem_util_pct": round(gpu_util * 0.8, 1),
            "gpu.mem_total_mb": 0,   # Unified memory — N/A on GB10
            "gpu.mem_free_mb": 0,
            "gpu.mem_used_mb": 0,
            "gpu.temp_c": round(gpu_temp, 1),
            "gpu.power_draw_w": round(max(3, gpu_power), 2),
            "gpu.power_limit_w": 0,
            "gpu.sm_clock_mhz": round(208 + gpu_util * 25, 0),
            "gpu.mem_clock_mhz": 0,
            "gpu.ecc_corrected": 0,
            "gpu.ecc_uncorrected": 0,
            "gpu.throttle_active": 0,
            "gpu.pcie_gen": 5,
            "gpu.persistence_mode": 1,
        }

        # Top processes (fake)
        procs = [
            {"pid": 1234 + i, "user": "canberk" if i % 2 == 0 else "root",
             "cpu_pct": round(self.rng.uniform(0, 20) if i > 0 else self.rng.uniform(20, 80), 1),
             "mem_pct": round(self.rng.uniform(0, 5), 1),
             "command": c}
            for i, c in enumerate([
                "python3 -m vllm.entrypoints.openai.api_server" if is_inference_active else "idle",
                "dockerd", "containerd", "sshd", "systemd", "node_exporter",
                "kworker", "rcu_sched",
            ])
        ]
        gpu_procs = []
        if is_inference_active:
            gpu_procs = [{"pid": 554137, "name": "VLLM::EngineCore", "mem_mb": 104639}]

        # vLLM data (only Neo in demo runs vLLM)
        vllm_data = None
        if self.host_name == "neo":
            vllm_data = {
                "active": True,
                "container": "vllm-qwen36",
                "port": 8000,
                "image": "nvcr.io/nvidia/vllm:26.03-py3",
                "model": "qwen3.6-35b",
                "model_root": "/models/Qwen3.6-35B-A3B-FP8",
                "max_model_len": 65536,
                "models_count": 1,
                "requests_running": 1.0 if is_inference_active else 0.0,
                "requests_waiting": 0.0,
                "kv_cache_pct": round(self.rng.uniform(0.1, 15) if is_inference_active else 0.1, 2),
                "prompt_tokens_total": self.total_prompt_tokens,
                "generation_tokens_total": self.total_gen_tokens,
                "gen_tokens_per_s": round(gen_tokens_per_s, 2),
                "prompt_tokens_per_s": round(prompt_tokens_this_tick / poll_interval, 2),
                "prefix_cache_hit_pct": round(
                    (self.prefix_cache_hits / max(self.prefix_cache_queries, 1)) * 100, 1
                ),
                "ts": time.monotonic(),
            }

        return {
            "metrics": metrics,
            "gpu_procs": gpu_procs,
            "top_procs": procs,
            "vllm": vllm_data,
        }


class MockCollector:
    """Drop-in replacement for SSH collector in demo mode."""

    def __init__(self, hosts: dict):
        self._hosts = hosts
        self._states: dict[str, MockState] = {}
        for i, name in enumerate(hosts.keys()):
            self._states[name] = MockState(name, seed=i * 1000)

    @property
    def online_status(self) -> dict[str, bool]:
        return {h: True for h in self._hosts}

    async def collect(self, host_name: str):
        """Matches SSHPool.collect signature: (metrics, gpu_procs, top_procs)."""
        state = self._states.get(host_name)
        if not state:
            return None
        data = state.tick()
        return (data["metrics"], data["gpu_procs"], data["top_procs"])

    async def run_command(self, host_name: str, command: str) -> dict:
        """Simulated command execution."""
        return {
            "exit_code": 0,
            "stdout": f"[demo mode] Would run on {host_name}: {command}\n",
            "stderr": "",
            "duration_ms": 42,
        }

    async def close_all(self):
        pass


async def mock_vllm_collect(collector: MockCollector, host_name: str, prev: Optional[dict] = None) -> Optional[dict]:
    """Drop-in for vllm_collector.collect_vllm in demo mode."""
    state = collector._states.get(host_name)
    if not state:
        return None
    return state.tick()["vllm"]
