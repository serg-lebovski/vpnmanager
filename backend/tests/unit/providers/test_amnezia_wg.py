from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.providers.amnezia_wg import AmneziaWGProvider
from app.providers.base import PeerSpec, ProviderError
from app.providers.ssh_utils import CommandResult, SSHCredentials


class FakeConnection:
    def __init__(self, failing_prefixes: tuple[str, ...] = ()) -> None:
        self.commands: list[str] = []
        self.inputs: list[str] = []
        self._failing_prefixes = failing_prefixes

    async def run(self, command: str, input: str | None = None, check: bool = False):
        self.commands.append(command)
        if input is not None:
            self.inputs.append(input)
        exit_status = 1 if any(command.startswith(p) for p in self._failing_prefixes) else 0
        result = SimpleNamespace(exit_status=exit_status, stdout="", stderr="boom" if exit_status else "")
        if check and exit_status != 0:
            raise RuntimeError("ssh command failed")
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


def make_provider(conn: FakeConnection, **overrides) -> AmneziaWGProvider:
    creds = SSHCredentials(host="1.2.3.4", port=22, username="root", password="pw")
    defaults = dict(
        wg_interface="awg0",
        server_public_key="server_pub",
        subnet="10.8.0.0/24",
        endpoint="vpn.example.com",
        wg_port=51871,
        obfuscation={"Jc": 4, "Jmin": 40, "Jmax": 70, "S1": 68, "S2": 149, "H1": 1, "H2": 2, "H3": 3, "H4": 4},
    )
    defaults.update(overrides)
    return AmneziaWGProvider(creds, ssh_client=FakeSSHClient(conn), **defaults)


@pytest.mark.asyncio
async def test_create_peer_success():
    conn = FakeConnection()
    provider = make_provider(conn)
    spec = PeerSpec(name="Ivanov — Laptop", public_key=None, preshared_key=None)

    result = await provider.create_peer(spec, used_ips={"10.8.0.2"})

    assert result.vpn_ip == "10.8.0.3"
    assert result.private_key is not None
    assert "Jc = 4" in result.config_text
    assert any(cmd.startswith("awg set awg0 peer") for cmd in conn.commands)
    assert any(cmd.startswith("awg-quick save") for cmd in conn.commands)
    # временный файл с preshared-key должен быть удалён
    assert any(cmd.startswith("rm -f /tmp/psk_") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_create_peer_raises_on_awg_set_failure():
    conn = FakeConnection(failing_prefixes=("awg set",))
    provider = make_provider(conn)
    spec = PeerSpec(name="X", public_key=None, preshared_key=None)

    with pytest.raises(ProviderError):
        await provider.create_peer(spec, used_ips=set())

    # даже при ошибке временный файл должен быть подчищен (finally)
    assert any(cmd.startswith("rm -f /tmp/psk_") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_create_peer_uses_docker_exec_when_containerized():
    conn = FakeConnection()
    provider = make_provider(conn, container_name="amnezia-awg")
    spec = PeerSpec(name="X", public_key=None, preshared_key=None)

    await provider.create_peer(spec, used_ips=set())

    assert any(cmd.startswith("docker exec amnezia-awg awg set") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_delete_peer_sends_remove_and_save():
    conn = FakeConnection()
    provider = make_provider(conn)
    await provider.delete_peer("some_public_key")
    assert any("peer some_public_key remove" in cmd for cmd in conn.commands)
    assert any(cmd.startswith("awg-quick save") for cmd in conn.commands)


@pytest.mark.asyncio
async def test_get_stats_parses_dump_output():
    header = "priv\tpub\tport\tfwmark"
    peer_line = "peerpubkey\tpsk\tendpoint\tallowed\t1700000000\t1024\t2048\t25"
    dump_output = f"{header}\n{peer_line}"
    conn = FakeConnection()
    provider = make_provider(conn)
    provider._ssh._run_simple_result = CommandResult(0, dump_output, "")  # type: ignore[attr-defined]

    stats = await provider.get_stats()

    assert len(stats) == 1
    assert stats[0].peer_id == "peerpubkey"
    assert stats[0].rx_bytes == 1024
    assert stats[0].tx_bytes == 2048
    assert stats[0].last_handshake is not None


@pytest.mark.asyncio
async def test_health_check_true_and_false():
    conn = FakeConnection()
    provider = make_provider(conn)
    provider._ssh._run_simple_result = CommandResult(0, "interface data", "")  # type: ignore[attr-defined]
    assert await provider.health_check() is True

    provider._ssh._run_simple_result = CommandResult(1, "", "no such device")  # type: ignore[attr-defined]
    assert await provider.health_check() is False
