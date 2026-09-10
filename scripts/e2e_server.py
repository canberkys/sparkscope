"""Disposable real API + loopback SSH fixture for playwright.real.config.ts.

Never reads workstation configuration or contacts a real device. The fixture
implements SSH protocol/authentication, but its hardware output is synthetic.
"""

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

import asyncssh
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sparkscope.api import create_app
from sparkscope.config import Settings
from sparkscope.security import private_file

SYSTEM = """---CPU_STAT---
cpu 100 0 100 700 0 0 0 0 0 0
---MEMINFO---
MemTotal: 134217728 kB
MemAvailable: 80000000 kB
---LOADAVG---
0.3 0.2 0.1 1/300 99
---GPU---
40, 20, [N/A], [N/A], [N/A], 50, 60, 150, 1000, 1000
---UPTIME---
10000 1
"""


class FixtureSSH(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def validate_password(self, username, password):
        return username == "fixture" and password in ("fixture-password-one", "fixture-password-two")


async def process(proc):
    # Commands are matched, never executed by a shell.
    if "---CPU_STAT---" in proc.command:
        output = SYSTEM
    elif proc.command.startswith("hostname;"):
        output = (
            "fixture-node\n6.14-fixture\nSynthetic Linux\n"
            "GPU-fixture, 0, NVIDIA GB10, fixture, [N/A]\n"
            '---GPUSTATUS---\n0\n0\n---NETWORK---\n[{"ifname":"eth0"}]\n'
            '---DISKS---\n{"blockdevices":[]}\n'
        )
    elif "nvme smart" in proc.command:
        output = '{"temperature":313,"percent_used":2}'
    elif proc.command.startswith("curl"):
        await proc.stdin.read()
        proc.exit(22)
        return
    else:
        output = ""
    proc.stdout.write(output)
    proc.exit(0)


async def main(args):
    with tempfile.TemporaryDirectory(prefix="sparkscope-real-e2e-") as directory:
        data = Path(directory)
        settings = Settings(
            data_dir=data,
            database_url=f"sqlite+aiosqlite:///{data / 'fleet.db'}",
            key_file=data / "master.secret",
            secure_cookie=False,
            origins=[f"http://127.0.0.1:{args.port}"],
        )
        key = asyncssh.generate_private_key("ssh-ed25519")
        ssh = await asyncssh.create_server(FixtureSSH, "127.0.0.1", 0, server_host_keys=[key], process_factory=process)
        app = create_app(settings)
        server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=args.port, access_log=False, log_level="error")
        )
        serving = asyncio.create_task(server.serve())
        try:
            while not server.started:
                if serving.done():
                    await serving
                    raise RuntimeError("Fixture application failed to start")
                await asyncio.sleep(0.05)
            manifest = {
                "ssh_port": ssh.get_port(),
                "fingerprint": key.get_fingerprint(),
                "setup_code": (data / "setup.secret").read_text().strip(),
                "data_dir": str(data),
            }
            args.manifest.parent.mkdir(parents=True, exist_ok=True)
            args.manifest.unlink(missing_ok=True)
            private_file(args.manifest, json.dumps(manifest))
            await serving
        finally:
            server.should_exit = True
            await serving
            ssh.close()
            await ssh.wait_closed()
            args.manifest.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8021)
    parser.add_argument("--manifest", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
