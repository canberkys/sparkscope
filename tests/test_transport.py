import asyncio

import asyncssh
import pytest

from sparkscope.security import Vault
from sparkscope.ssh import Transport


class PasswordServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def validate_password(self, username, password):
        return username == "tester" and password == "local-test-password"


async def test_real_ssh_protocol_pinning_auth_timeout_and_output_limit(tmp_path):
    key = asyncssh.generate_private_key("ssh-ed25519")

    async def process(proc):
        if proc.command == "slow":
            try:
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                return
        elif proc.command == "large":
            proc.stdout.write("x" * 200000)
        else:
            proc.stdout.write("ok\n")
        proc.exit(0)

    server = await asyncssh.create_server(
        PasswordServer, "127.0.0.1", 0, server_host_keys=[key], process_factory=process
    )
    transport = Transport(Vault(tmp_path / "key.secret"))
    identity = {
        "address": "127.0.0.1",
        "port": server.get_port(),
        "username": "tester",
        "password": "local-test-password",
    }
    try:
        discovered = await transport.host_key(identity["address"], identity["port"])
        assert discovered["fingerprint"] == key.get_fingerprint()
        conn = await transport.connect(identity, discovered["public_key"])
        try:
            result = await transport.run_on(conn, "uptime", 1)
            assert result["exit_code"] == 0 and result["stdout"] == "ok\n"
            large = await transport.run_on(conn, "large", 1)
            assert len(large["stdout"]) < 132000 and "[Output truncated]" in large["stdout"]
            slow = await transport.run_on(conn, "slow", 0.05)
            assert slow["timed_out"] and slow["exit_code"] is None
        finally:
            conn.close()
            await conn.wait_closed()
        other = asyncssh.generate_private_key("ssh-ed25519")
        with pytest.raises(asyncssh.HostKeyNotVerifiable):
            await transport.connect(identity, other.export_public_key().decode())
        with pytest.raises(asyncssh.PermissionDenied):
            await transport.connect({**identity, "password": "wrong"}, discovered["public_key"])
    finally:
        server.close()
        await server.wait_closed()
