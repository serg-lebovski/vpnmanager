from types import SimpleNamespace

import asyncssh
import pytest

import app.providers.ssh_utils as ssh_utils_module
from app.providers.base import ProviderAuthError, ProviderUnreachable
from app.providers.ssh_utils import SSHClient, SSHCredentials


def make_client(**overrides) -> SSHClient:
    creds = SSHCredentials(host="1.2.3.4", port=22, username="root", password="pw", **overrides)
    return SSHClient(creds)


@pytest.mark.asyncio
async def test_connect_wraps_permission_denied(monkeypatch):
    def fake_connect(**kwargs):
        raise asyncssh.PermissionDenied("nope")

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    client = make_client()
    with pytest.raises(ProviderAuthError):
        async with client.connect():
            pass


@pytest.mark.asyncio
async def test_connect_wraps_connection_error(monkeypatch):
    def fake_connect(**kwargs):
        raise OSError("network unreachable")

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    client = make_client()
    with pytest.raises(ProviderUnreachable):
        async with client.connect():
            pass


@pytest.mark.asyncio
async def test_connect_uses_private_key_when_provided(monkeypatch):
    captured = {}

    class FakeConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    def fake_connect(**kwargs):
        captured.update(kwargs)
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)
    monkeypatch.setattr(asyncssh, "import_private_key", lambda key: f"parsed:{key}")

    client = make_client()
    client._creds.private_key = "PEM_DATA"
    client._creds.password = None
    async with client.connect():
        pass

    assert captured["client_keys"] == ["parsed:PEM_DATA"]


@pytest.mark.asyncio
async def test_connect_creates_missing_known_hosts_file(monkeypatch, tmp_path):
    """Регрессия: known_hosts_path не существовал в контейнере -> FileNotFoundError
    вместо осмысленного подключения (обнаружено при добавлении реального сервера)."""
    known_hosts_path = tmp_path / "ssh" / "known_hosts"
    monkeypatch.setattr(
        ssh_utils_module, "get_settings",
        lambda: SimpleNamespace(ssh_known_hosts_path=str(known_hosts_path)),
    )

    class FakeConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    def fake_connect(**kwargs):
        assert kwargs["known_hosts"] == str(known_hosts_path)
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)

    client = make_client()
    async with client.connect():
        pass

    assert known_hosts_path.exists()


@pytest.mark.asyncio
async def test_connect_tofu_accepts_and_remembers_unknown_host_key(monkeypatch, tmp_path):
    known_hosts_path = tmp_path / "known_hosts"
    known_hosts_path.touch()
    monkeypatch.setattr(
        ssh_utils_module, "get_settings",
        lambda: SimpleNamespace(ssh_known_hosts_path=str(known_hosts_path)),
    )

    class FakeHostKey:
        def export_public_key(self, format_name="openssh"):
            return b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIQ comment\n"

    class FakeConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        def get_server_host_key(self):
            return FakeHostKey()

    calls = []

    def fake_connect(**kwargs):
        calls.append(kwargs["known_hosts"])
        if kwargs["known_hosts"] is not None:
            raise asyncssh.HostKeyNotVerifiable("unknown host")
        return FakeConn()

    monkeypatch.setattr(asyncssh, "connect", fake_connect)

    client = make_client()
    async with client.connect():
        pass

    assert calls == [str(known_hosts_path), None]
    content = known_hosts_path.read_text()
    assert "1.2.3.4" in content
    assert "ssh-ed25519" in content
