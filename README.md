# GB10 Cluster Dashboard

Real-time monitoring dashboard for NVIDIA DGX Spark / Dell Pro Max with GB10 cluster nodes. Runs on your laptop/workstation, monitors 1–N GB10 hosts over SSH, and streams live metrics via WebSocket to a glassmorphism dark-themed web UI.

<!-- Screenshot placeholder — add your own screenshots to docs/ and reference them here -->
<!-- ![Dashboard preview](docs/screenshot.png) -->

A stylized device icon (`static/device.svg`) is used in the UI so the repo stays free of vendor product photography.

## Features

**System metrics** (2-second polling, single SSH round-trip per host):
- CPU utilization, load average (1m/5m/15m), max thermal-zone temperature
- GPU utilization, VRAM, temperature, power draw, SM/memory clock
- **GPU health**: ECC errors (corrected/uncorrected), throttle reasons, PCIe generation, persistence mode
- **NVMe SMART** (slow-poll 60s): temperature, wear level, media errors
- Memory (total/available/cached/buffers + swap), disk (root + NVMe IOPS/throughput)
- Network (WiFi + cluster links rx/tx Mbps + error rates)
- Top CPU processes, GPU compute processes

**vLLM inference integration** (auto-detected):
- Loaded model name + max context length shown in host header
- Token generation rate (tokens/sec)
- Active / queued requests
- KV cache usage
- Prefix cache hit rate
- Total prompt / generation tokens
- Metrics persisted for historical trending

**UI**:
- Live time-series charts (raw canvas, no Chart.js dependency)
- Historical query with time range selector (Live / 5m / 15m / 1h / 6h / 24h)
- Inline host info (hostname, IP, kernel, OS, GPU model)
- Native `<details>` collapsible widgets per section
- Inline SVG sparklines in metric cards
- Hover tooltips on all charts
- Alert timeline (Gantt view for last 24h)

**Commands panel** (whitelisted, SSH):
- System: uptime, kernel info, reboot, shutdown, apt update/upgrade
- GPU: `nvidia-smi` full output, GPU processes, GPU reset
- Network: interface status, ping cluster peer, WiFi quality
- Logs: `dmesg`, journalctl errors, NVIDIA kernel messages
- Confirmation modal for destructive commands
- Output modal for readable display

**Alerting**:
- Threshold-based, 3-consecutive-sample policy
- CPU/GPU temperature, disk usage, memory usage, GPU power
- **ECC uncorrected error** → critical (early hardware failure signal)
- **GPU throttling active** → warning

**Observability**:
- SQLite with 24h retention, WAL mode, persistent connection
- Alert table (active + resolved history)
- Graceful SSH reconnect with exponential backoff

## Requirements

- macOS (developed on Apple Silicon — should work on Linux with minor tweaks)
- Python 3.11+
- [uv](https://docs.astral.sh/uv/) package manager
- Passwordless SSH access to each GB10 host (`~/.ssh/config` aliases)

## Quick Start

```bash
# Install uv if you don't have it
brew install uv

# Clone
git clone <this-repo> gb10-dashboard
cd gb10-dashboard

# Install dependencies
uv sync

# Configure
cp config.example.yaml config.yaml
vim config.yaml   # set ssh_alias, IPs per host

# Initialize database
uv run python -c "from db import init_db, set_db_path; import asyncio; set_db_path('~/.gb10-dashboard/metrics.db'); asyncio.run(init_db())"

# Run
uv run uvicorn app:app --host 127.0.0.1 --port 8000

# Open
open http://localhost:8000
```

## SSH Setup (each host)

Add each node to `~/.ssh/config`:

```
Host host1
    HostName 10.0.0.10
    User <your-user>
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60

Host host2
    HostName 10.0.0.11
    User <your-user>
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60
```

Copy your public key to each host: `ssh-copy-id host1`, `ssh-copy-id host2`.

## Optional (per host)

**Passwordless sudo for safe commands** — create `/etc/sudoers.d/dashboard` on each GB10:
```
<your-user> ALL=(ALL) NOPASSWD: /usr/sbin/nvme, /usr/bin/nvidia-smi, /usr/sbin/reboot, /usr/sbin/shutdown, /usr/bin/apt, /usr/bin/apt-get
```

**User in `docker` group** (if you run vLLM in containers) — dashboard auto-detects vLLM when `docker ps` works without sudo.

**NVMe SMART** — requires `nvme-cli` (usually preinstalled on DGX OS).

## macOS Autostart (optional)

```bash
cp launchd/gb10-dashboard.plist.example ~/Library/LaunchAgents/
# Edit WorkingDirectory and username paths first
launchctl load ~/Library/LaunchAgents/gb10-dashboard.plist.example
```

## Architecture

```
┌─────────────────────────────┐
│  Browser (Alpine.js + canvas)  │
└────────────┬────────────────┘
             │ WebSocket (2s push)
┌────────────▼────────────────┐
│  FastAPI + uvicorn          │
│  ┌───────────────────────┐  │
│  │  polling_loop (2s)    │  │
│  │  nvme_slow_poll (60s) │  │
│  │  retention_loop       │  │
│  └──────┬────────────────┘  │
│         │                   │
│  ┌──────▼──────┐  ┌──────┐  │
│  │ ssh_collect │  │ vllm │  │
│  │ (asyncssh)  │  │ coll │  │
│  └──────┬──────┘  └───┬──┘  │
│         │             │     │
│         ▼             ▼     │
│      ┌──────────────────┐   │
│      │ SQLite (WAL)     │   │
│      │  — metrics       │   │
│      │  — gpu_processes │   │
│      │  — commands_log  │   │
│      │  — alerts        │   │
│      └──────────────────┘   │
└─────────────────────────────┘
             ↓ SSH (persistent)
     ┌───────┴───────┐
┌────▼────┐     ┌────▼────┐
│  host1  │     │  host2  │
│ (GB10)  │     │ (GB10)  │
└─────────┘     └─────────┘
```

## Similar Projects

- [paul-aviles/NVIDIA-DGX-Spark-Dashboard](https://github.com/paul-aviles/NVIDIA-DGX-Spark-Dashboard) — simpler 2-node dashboard
- [thx0701/dgx-spark-status](https://github.com/thx0701/dgx-spark-status) — SvelteKit version with Ollama/vLLM/llama.cpp support
- [NVIDIA/dgx-spark-playbooks](https://github.com/NVIDIA/dgx-spark-playbooks) — official setup playbooks
- [rossingram/Spark-DGX-Benchmark](https://github.com/rossingram/Spark-DGX-Benchmark) — benchmark scripts

## License

MIT

## Notes

- Dashboard binds to `127.0.0.1` only by default — no external exposure.
- All SSH commands that mutate state (reboot, gpu_reset, apt_upgrade) are whitelisted and require UI confirmation.
- `config.yaml` is `.gitignore`d — keep secrets local.
- The device icon (`static/device.svg`) is a generic SVG drawn for this project to avoid any vendor-logo/trademark concerns.
