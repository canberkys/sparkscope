"""Build an isolated Compose/HTTPS installation and rehearse PostgreSQL restore.

Uses only the colima-sparkscope-test Docker context, a unique Compose project,
temporary passwords/keys/certificate and paused synthetic inventory. Cleans up
only its own project. This is local acceptance, not deployment to a real server.
"""

import argparse
import asyncio
import hashlib
import json
import os
import secrets
import ssl
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import httpx
import websockets
import yaml

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = "colima-sparkscope-test"
PYTHON = "/app/.venv/bin/python"
REDACT_VALUES = []


def command(args, *, data=None, timeout=900):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        detail = (result.stdout + result.stderr).decode(errors="replace")[-6000:]
        for value in REDACT_VALUES:
            detail = detail.replace(value, "[REDACTED]")
        raise RuntimeError(f"Validation command failed (exit {result.returncode}, executable {args[0]}): {detail}")
    return result.stdout


async def websocket_check(origin, cookie, tls):
    async with websockets.connect(
        origin.replace("https:", "wss:") + "/api/v1/live",
        origin=origin,
        ssl=tls,
        additional_headers={"Cookie": f"sparkscope_session={cookie}"},
    ) as ws:
        message = json.loads(await asyncio.wait_for(ws.recv(), 10))
        assert message["type"] == "snapshot"


def app_code(compose, code):
    return command(compose + ["exec", "-T", "app", PYTHON, "-c", code])


def run(args):
    report = {
        "synthetic_only": True,
        "docker_context": CONTEXT,
        "real_hardware_acceptance": False,
        "reference_server_acceptance": False,
        "previous_release_code_rollback": False,
        "checks": [],
        "passed": False,
        "source_sha256": {
            str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(
                [
                    *ROOT.glob("sparkscope/*.py"),
                    *ROOT.glob("migrations/versions/*.py"),
                    ROOT / "deployment/Dockerfile",
                    ROOT / "deployment/compose.yaml",
                ]
            )
        },
    }

    def passed(name):
        report["checks"].append(name)
        print(json.dumps({"passed": name}), flush=True)

    # Colima shares the user home; macOS /var/folders temporary paths are not
    # necessarily visible inside its VM and cannot safely back bind mounts.
    runtime = ROOT / ".runtime" / "validation"
    runtime.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sparkscope-deployment-", dir=runtime) as directory:
        path = Path(directory)
        project = "sparkscope-validation-" + uuid.uuid4().hex[:10]
        compose_path = path / "compose.yaml"
        compose = ["docker", "--context", CONTEXT, "compose", "-p", project, "-f", str(compose_path)]
        password = secrets.token_urlsafe(32)
        REDACT_VALUES.append(password)
        origin = f"https://127.0.0.1:{args.https_port}"
        stack = yaml.safe_load((ROOT / "deployment/compose.yaml").read_text())
        stack["services"]["db"]["environment"]["POSTGRES_PASSWORD"] = password
        app = stack["services"]["app"]
        app["build"]["context"] = str(ROOT)
        app["ports"] = [f"127.0.0.1:{args.http_port}:8010"]
        app["environment"] = {
            "SPARKSCOPE_DATABASE_URL": f"postgresql+asyncpg://sparkscope:{password}@db:5432/sparkscope",
            "SPARKSCOPE_ORIGINS": origin,
            "SPARKSCOPE_SECURE_COOKIE": "1",
        }
        (path / "openssl.cnf").write_text(
            "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n"
            "[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n"
            "basicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n"
        )
        command(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-keyout",
                str(path / "tls.key"),
                "-out",
                str(path / "tls.crt"),
                "-config",
                str(path / "openssl.cnf"),
            ]
        )
        os.chmod(path / "tls.key", 0o600)
        (path / "nginx.conf").write_text(
            "server { listen 443 ssl; server_name 127.0.0.1;\n"
            "ssl_certificate /fixture/tls.crt; ssl_certificate_key /fixture/tls.key;\n"
            "location / { proxy_pass http://app:8010; proxy_http_version 1.1;\n"
            "proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https;\n"
            'proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";\n'
            "proxy_read_timeout 60s; } }\n"
        )
        stack["services"]["proxy"] = {
            "image": "nginx:stable-alpine",
            "ports": [f"127.0.0.1:{args.https_port}:443"],
            "depends_on": ["app"],
            "volumes": [
                f"{path}/nginx.conf:/etc/nginx/conf.d/default.conf:ro",
                f"{path}/tls.crt:/fixture/tls.crt:ro",
                f"{path}/tls.key:/fixture/tls.key:ro",
            ],
        }

        def write_compose():
            compose_path.write_text(yaml.safe_dump(stack))
            os.chmod(compose_path, 0o600)

        write_compose()
        tls = ssl.create_default_context(cafile=str(path / "tls.crt"))
        try:
            command(compose + ["config", "--quiet"])
            print(json.dumps({"phase": "building isolated application image"}), flush=True)
            command(compose + ["up", "-d", "--build"], timeout=1200)
            passed("compose_build_start")
            with httpx.Client(base_url=origin, verify=tls, timeout=10, headers={"Origin": origin}) as client:

                def ready():
                    for _ in range(90):
                        try:
                            response = client.get("/api/v1/auth/status")
                            if response.status_code == 200:
                                return response.json()
                        except httpx.HTTPError:
                            pass
                        time.sleep(1)
                    raise RuntimeError("HTTPS application did not become ready")

                assert ready()["setup_required"]
                assert "<html" in client.get("/").text.lower()
                passed("https_verified_certificate_and_frontend")
                setup = command(compose + ["exec", "-T", "app", "cat", "/data/setup.secret"]).decode().strip()
                admin_password = secrets.token_urlsafe(32)
                REDACT_VALUES.extend([setup, admin_password])
                response = client.post(
                    "/api/v1/auth/setup",
                    json={
                        "username": "validation-admin",
                        "password": admin_password,
                        "token": setup,
                    },
                )
                response.raise_for_status()
                cookie_header = response.headers["set-cookie"].lower()
                assert "secure" in cookie_header and "httponly" in cookie_header and "samesite=strict" in cookie_header
                client.headers["X-CSRF-Token"] = response.json()["csrf"]
                passed("setup_secure_httponly_samesite_cookie")
                asyncio.run(websocket_check(origin, client.cookies.get("sparkscope_session"), tls))
                passed("https_websocket_upgrade_authenticated_snapshot")
                rejected = client.post("/api/v1/users", headers={"Origin": "https://attacker.invalid"}, json={})
                assert rejected.status_code == 403
                passed("cross_origin_write_rejected")

                seed = """import asyncio
from sparkscope.config import Settings
from sparkscope.database import Database
from sparkscope.security import Vault
from sparkscope.models import Device
async def seed():
 s=Settings(); db=Database(s.database_url); vault=Vault(s.key_file)
 async with db.session() as tx:
  tx.add(Device(name="Restore fixture",address="192.0.2.1",username="synthetic",paused=True,
   host_key="synthetic",secret=vault.seal({"password":"synthetic-restore-secret"})))
 await db.close()
asyncio.run(seed())
"""
                app_code(compose, seed)
                inventory = client.get("/api/v1/devices").json()
                assert len(inventory) == 1 and inventory[0]["name"] == "Restore fixture"
                device_id = inventory[0]["id"]
                command(compose + ["restart", "app"])
                assert not ready()["setup_required"]
                assert client.get("/api/v1/devices").json()[0]["id"] == device_id
                passed("container_restart_inventory_session_key_persistence")

                backup = command(
                    compose + ["exec", "-T", "db", "pg_dump", "-U", "sparkscope", "-d", "sparkscope", "-Fc"]
                )
                key = command(compose + ["exec", "-T", "app", "cat", "/var/lib/sparkscope-secrets/master.secret"])
                (path / "fleet.dump").write_bytes(backup)
                (path / "master.secret").write_bytes(key)
                for filename in ("fleet.dump", "master.secret"):
                    os.chmod(path / filename, 0o600)
                response = client.patch(
                    f"/api/v1/devices/{device_id}",
                    json={"name": "After backup", "group": "Validation", "tags": [], "paused": True},
                )
                response.raise_for_status()
                assert response.json()["name"] == "After backup"
                command(compose + ["stop", "app"])
                command(compose + ["exec", "-T", "db", "createdb", "-U", "sparkscope", "sparkscope_restored"])
                command(
                    compose
                    + [
                        "exec",
                        "-T",
                        "db",
                        "pg_restore",
                        "-U",
                        "sparkscope",
                        "-d",
                        "sparkscope_restored",
                        "--exit-on-error",
                    ],
                    data=backup,
                )
                app["environment"]["SPARKSCOPE_DATABASE_URL"] = (
                    f"postgresql+asyncpg://sparkscope:{password}@db:5432/sparkscope_restored"
                )
                write_compose()
                command(compose + ["up", "-d", "--no-build", "app"])
                # Nginx resolves the new container address on restart.
                command(compose + ["restart", "proxy"])
                assert not ready()["setup_required"]
                response = client.post(
                    "/api/v1/auth/login", json={"username": "validation-admin", "password": admin_password}
                )
                response.raise_for_status()
                restored = client.get("/api/v1/devices").json()
                assert restored[0]["id"] == device_id and restored[0]["name"] == "Restore fixture"
                assert (
                    command(compose + ["exec", "-T", "app", "cat", "/var/lib/sparkscope-secrets/master.secret"]) == key
                )
                verify = """import asyncio
from sqlalchemy import select
from sparkscope.config import Settings
from sparkscope.database import Database
from sparkscope.security import Vault
from sparkscope.models import Device
async def verify():
 s=Settings(); db=Database(s.database_url); vault=Vault(s.key_file)
 async with db.session() as tx:
  rows=(await tx.scalars(select(Device))).all()
  assert len(rows)==1
  assert vault.open(rows[0].secret)["password"]=="synthetic-restore-secret"
 await db.close()
asyncio.run(verify())
"""
                app_code(compose, verify)
                passed("postgres_backup_restore_fresh_database_login_and_credential_decryption")
                passed("post_backup_mutation_rolled_back_same_application_image")
            report["passed"] = True
        except Exception as error:
            report["error"] = type(error).__name__
            # Only our own constant error messages are emitted, never server responses.
            if isinstance(error, RuntimeError):
                report["detail"] = str(error)
        finally:
            try:
                command(compose + ["down", "--volumes", "--remove-orphans"], timeout=120)
                report["isolated_resources_removed"] = True
            except Exception:
                report["isolated_resources_removed"] = False
                report["cleanup_project"] = project
                report["passed"] = False
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-port", type=int, default=18010)
    parser.add_argument("--https-port", type=int, default=18443)
    parser.add_argument("--output", type=Path, required=True)
    raise SystemExit(run(parser.parse_args()))
