from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.providers.base import PeerSpec, ProviderError
from app.providers.ssh_utils import CommandResult, SSHCredentials
from app.providers.wireguard import WireGuardProvider


class FakeConnection:
    def __init__(self, failing_prefixes: tuple[str, ...] = ()) -> None:
        self.commands: list[str] = []
        self._failing_prefixes = failing_prefixes

    async def run(self, command: str, input: str | None = None, check: bool = False):
        self.commands.append(command)
        exit_status = 1 if any(command.startswith(p) for p in self._failing_prefixes) else 0
        result = SimpleNamespace(exit_status=exit_status, stdout="", stderr="boom" if exit_status else "")
        if check and exit_status != 0:
            raise RuntimeError("ssh failed")
        return result


class FakeSSHClient:
    def __init__(self, conn: FakeConnection, run_simple_result: CommandResult | None = None) -> None:
        self._conn = conn
        self._run_simple_result = run_simple_result or CommandResult(0, "", "")

    @asynccontextmanager
    async def connect(self, timeout: float = 20.0):
        yield self._conn

    async def run_simple(self, argv: list[str], timeout: float = 20.0) -> CommandResult:
        return self._run_simple_result


def make_provider(conn: FakeConnection) -> WireGuardProvider:
    creds = SSHCredentials(host="1.2.3.4", port=22, username="root", password="pw")
    return WireGuardProvider(
        creds,
        wg_interface="wg0",
        server_public_key="server_pub",
        subnet="10.9.0.0/24",
        endpoint="vpn.example.com",
        wg_port=51820,
        ssh_client=FakeSSHClient(conn),
    )


@pytest.mark.asyncio
async def test_create_peer_no_obfuscation_in_config():
    conn = FakeConnection()
    provider = make_provider(conn)
    result = await provider.create_peer(
        PeerSpec(name="X", public_key=None, preshared_key=None), used_ips=set()
    )
    assert result.vpn_ip == "10.9.0.2"
    assert "Jc" not in result.config_text


@pytest.mark.asyncio
async def test_create_peer_failure_raises_and_cleans_up():
    conn = FakeConnection(failing_prefixes=("wg set",))
    provider = make_provider(conn)
    with pytest.raises(ProviderError):
        await provider.create_peer(PeerSpec(name="X", public_key=None, preshared_key=None), used_ips=set())
    assert any(cmd.startswith("rm -f /tmp/psk_") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_delete_peer_sends_remove_and_save():
    conn = FakeConnection()
    provider = make_provider(conn)
    await provider.delete_peer("pubkey123")
    assert any("peer pubkey123 remove" in cmd for cmd in conn.commands)
    assert any(cmd.startswith("wg-quick save") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_get_stats_parses_dump_output():
    header = "priv\tpub\tport\tfwmark"
    peer_line = "peerpubkey\tpsk\tendpoint\tallowed\t1700000000\t1024\t2048\t25"
    conn = FakeConnection()
    provider = make_provider(conn)
    provider._ssh._run_simple_result = CommandResult(0, f"{header}\n{peer_line}", "")  # type: ignore[attr-defined]

    stats = await provider.get_stats()

    assert len(stats) == 1
    assert stats[0].peer_id == "peerpubkey"
    assert stats[0].rx_bytes == 1024
    assert stats[0].tx_bytes == 2048


@pytest.mark.asyncio
async def test_get_stats_returns_empty_when_command_fails():
    conn = FakeConnection()
    provider = make_provider(conn)
    provider._ssh._run_simple_result = CommandResult(1, "", "no such device")  # type: ignore[attr-defined]
    assert await provider.get_stats() == []


@pytest.mark.asyncio
async def test_health_check_true_and_false():
    conn = FakeConnection()
    provider = make_provider(conn)
    provider._ssh._run_simple_result = CommandResult(0, "interface data", "")  # type: ignore[attr-defined]
    assert await provider.health_check() is True

    provider._ssh._run_simple_result = CommandResult(1, "", "no such device")  # type: ignore[attr-defined]
    assert await provider.health_check() is False


@pytest.mark.asyncio
async def test_rotate_keys_updates_server_public_key():
    conn = FakeConnection()
    provider = make_provider(conn)
    old_key = provider.server_public_key
    await provider.rotate_keys()
    assert provider.server_public_key != old_key
    assert any(cmd.startswith("rm -f /tmp/rotate_") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_rotate_keys_failure_raises():
    conn = FakeConnection(failing_prefixes=("cat /tmp/rotate_",))
    provider = make_provider(conn)
    with pytest.raises(ProviderError):
        await provider.rotate_keys()
