import asyncssh
import pytest

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
