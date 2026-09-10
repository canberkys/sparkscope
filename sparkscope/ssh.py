"""Pinned host keys and bounded remote I/O. No credentials in command logs."""

import asyncio
import json
import math
import time

import asyncssh

from .parsers import METRIC_COMMAND, MetricParser


class SSHFailure(Exception):
    pass


def safe_error(exc):
    if isinstance(exc, asyncssh.HostKeyNotVerifiable):
        return "SSH host key changed or is not trusted. Verify it before reconnecting."
    if isinstance(exc, asyncssh.PermissionDenied):
        return "SSH authentication failed. Check the username and credentials."
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return "Connection or command timed out."
    if isinstance(exc, SSHFailure):
        return str(exc)
    return "SSH connection failed. Check the address, port and network access."


class Transport:
    def __init__(self, vault):
        self.vault = vault
        self.connections = {}
        self.locks = {}
        self.parsers = MetricParser()

    async def host_key(self, address, port):
        key = await asyncio.wait_for(asyncssh.get_server_host_key(address, port=port, config=None), 8)
        if key is None:
            raise SSHFailure("The SSH server did not provide a host key.")
        return {"public_key": key.export_public_key().decode().strip(), "fingerprint": key.get_fingerprint()}

    async def connect(self, identity, host_key):
        if not host_key:
            raise SSHFailure("Verify the SSH host key before connecting.")
        kwargs = dict(
            host=identity["address"],
            port=identity.get("port", 22),
            username=identity["username"],
            known_hosts=([asyncssh.import_public_key(host_key)], [], []),
            config=None,
            keepalive_interval=15,
            keepalive_count_max=2,
            agent_path=None,
        )
        auth = identity.get("auth_type", "password")
        if auth == "password":
            kwargs.update(
                password=identity.get("password", ""), client_keys=[], preferred_auth="password,keyboard-interactive"
            )
        elif auth == "key":
            kwargs["client_keys"] = [
                asyncssh.import_private_key(identity["private_key"], passphrase=identity.get("passphrase") or None)
            ]
        elif auth == "ssh_config":
            kwargs.pop("config")
            kwargs.pop("agent_path")
        return await asyncio.wait_for(asyncssh.connect(**kwargs), 8)

    async def connection(self, device):
        async with self.locks.setdefault(device.id, asyncio.Lock()):
            cached = self.connections.get(device.id)
            if cached and cached[0] == device.revision and not cached[1].is_closed():
                return cached[1]
            await self.close(device.id)
            secret = self.vault.open(device.secret)
            identity = {**secret, "address": device.address, "port": device.port, "username": device.username}
            conn = await self.connect(identity, device.host_key)
            self.connections[device.id] = (device.revision, conn)
            return conn

    async def close(self, device_id):
        item = self.connections.pop(device_id, None)
        if item:
            item[1].close()
            await item[1].wait_closed()
        for cache in (self.parsers._prev_cpu, self.parsers._prev_disk, self.parsers._prev_net):
            cache.pop(device_id, None)

    async def close_all(self):
        await asyncio.gather(*(self.close(k) for k in list(self.connections)))

    async def run_on(self, conn, command, timeout=30, stdin=None):
        start = time.monotonic()
        proc = None

        async def read(stream):
            chunks = []
            size = 0
            while True:
                part = await stream.read(8192)
                if not part:
                    break
                if size < 131072:
                    chunks.append(part[: 131072 - size])
                size += len(part)
            return "".join(chunks) + ("\n[Output truncated]" if size > 131072 else "")

        try:
            async with asyncio.timeout(timeout):
                proc = await conn.create_process(command, encoding="utf-8")
                if stdin:
                    proc.stdin.write(stdin)
                proc.stdin.write_eof()
                stdout, stderr = await asyncio.gather(read(proc.stdout), read(proc.stderr))
                await proc.wait_closed()
                return {
                    "exit_code": proc.exit_status if proc.exit_status is not None else -1,
                    "stdout": stdout,
                    "stderr": stderr,
                    "duration_ms": round((time.monotonic() - start) * 1000),
                    "timed_out": False,
                }
        except TimeoutError:
            if proc:
                proc.close()
            return {
                "exit_code": None,
                "stdout": "",
                "stderr": "Timed out. The remote operation may still be running; verify its state before retrying.",
                "duration_ms": round((time.monotonic() - start) * 1000),
                "timed_out": True,
            }
        except asyncio.CancelledError:
            if proc:
                proc.close()
            raise

    async def run(self, device, command, timeout=30, stdin=None):
        return await self.run_on(await self.connection(device), command, timeout, stdin)

    async def system(self, device):
        result = await self.run(device, METRIC_COMMAND, 8)
        if result["timed_out"]:
            raise TimeoutError()
        if "---CPU_STAT---" not in result["stdout"]:
            raise SSHFailure("Metric collection returned no supported system data.")
        metrics, gpu, top = self.parsers._parse_output(device.id, result["stdout"])
        if "memory.total_kb" not in metrics:
            raise SSHFailure("System metrics unavailable. Linux /proc access is required.")
        return {"metrics": {k: v for k, v in metrics.items() if v is not None}, "gpu_procs": gpu, "top_procs": top}

    async def info_on(self, conn):
        cmd = 'hostname; uname -r; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; nvidia-smi --query-gpu=uuid,index,name,driver_version,memory.total --format=csv,noheader,nounits 2>/dev/null; gpu_status=$?; echo "---GPUSTATUS---"; echo "$gpu_status"; command -v nvidia-smi >/dev/null 2>&1; echo $?; echo "---NETWORK---"; ip -j address 2>/dev/null; echo "---DISKS---"; lsblk -b -J -o NAME,TYPE,SIZE 2>/dev/null'
        r = await self.run_on(conn, cmd, 10)
        header, _, rest = r["stdout"].partition("---NETWORK---")
        network, _, disks = rest.partition("---DISKS---")
        header, _, gpu_status = header.partition("---GPUSTATUS---")
        lines = header.splitlines()
        status_codes = gpu_status.split()
        if r.get("timed_out"):
            raise TimeoutError("Hardware discovery timed out")

        def get(i):
            return lines[i] if len(lines) > i else ""

        def parse(raw, fallback):
            try:
                return json.loads(raw)
            except ValueError:
                return fallback

        gpu_rows = [line.strip() for line in lines[3:] if line.strip()]
        gpus = []
        for index, line in enumerate(gpu_rows):
            fields = [part.strip() for part in line.split(",")]
            if len(fields) == 5 and fields[0].startswith("GPU-"):
                try:
                    memory = float(fields[4])
                    if not math.isfinite(memory):
                        memory = None
                except ValueError:
                    memory = None
                gpus.append(
                    {
                        "id": fields[0],
                        "uuid": fields[0],
                        "index": int(fields[1]) if fields[1].isdigit() else index,
                        "name": fields[2],
                        "driver": fields[3],
                        "memory_total_mb": memory,
                        "last_seen": time.time(),
                        "present": True,
                    }
                )
            elif not status_codes:
                gpus.append(
                    {
                        "id": None,
                        "uuid": None,
                        "index": index,
                        "name": fields[0],
                        "driver": fields[-1] if len(fields) > 1 else "",
                        "present": True,
                    }
                )
        gpu_names = [gpu["name"] for gpu in gpus]
        gpu_state = (
            "available"
            if gpus
            else "unavailable"
            if status_codes and status_codes[0] != "0" and len(status_codes) > 1 and status_codes[1] == "0"
            else "unsupported"
        )
        network = parse(network, [])
        disks = parse(disks, {}).get("blockdevices", [])
        return {
            "hostname": get(0),
            "kernel": get(1),
            "os": get(2),
            "gpu": "; ".join(gpu_rows),
            "gpu_names": gpu_names,
            "gpu_count": len(gpu_names),
            "gpu_inventory_verified": bool(gpus) or bool(status_codes and status_codes[0] == "0" and not gpu_rows),
            "gpus": gpus,
            "capability_status": {"system": "available", "gpu": gpu_state},
            "hardware_checked_at": time.time(),
            "capability_details": {
                "gpu": (
                    "NVIDIA GPU telemetry available"
                    if gpus
                    else "NVIDIA driver or device query failed"
                    if gpu_state == "unavailable"
                    else "NVIDIA collection tool unavailable; GPU presence unknown"
                    if status_codes and len(status_codes) > 1 and status_codes[1] != "0"
                    else "No NVIDIA GPUs reported"
                )
            },
            "capabilities": {"system": True, "gpu": bool(gpu_names)},
            "warnings": [],
            "interfaces": [item["ifname"] for item in network if item.get("ifname") != "lo"],
            "network": network,
            "disks": disks,
        }

    async def smart(self, device):
        import re

        drives = [
            d["name"] for d in (device.info or {}).get("disks", []) if re.fullmatch(r"nvme\d+n\d+", d.get("name", ""))
        ]
        values = {}
        mapping = {
            "temperature": "temp_c",
            "avail_spare": "spare_pct",
            "percent_used": "used_pct",
            "media_errors": "media_errors",
            "critical_warning": "critical_warning",
        }
        for drive in (drives or ["nvme0n1"])[:16]:
            r = await self.run(device, f"sudo -n nvme smart-log /dev/{drive} -o json 2>/dev/null", 8)
            if r["exit_code"] != 0:
                continue
            try:
                data = json.loads(r["stdout"])
            except ValueError:
                continue
            for key, target in mapping.items():
                if not isinstance(data.get(key), (int, float)):
                    continue
                v = float(data[key])
                if target == "temp_c" and v > 200:
                    v -= 273.15
                values[f"nvme.{drive}.{target}"] = v
                # Summary shows the most stressed drive; detailed metrics remain available.
                summary = f"nvme.{target}"
                values[summary] = (
                    min(values.get(summary, v), v) if target == "spare_pct" else max(values.get(summary, v), v)
                )
        return values
