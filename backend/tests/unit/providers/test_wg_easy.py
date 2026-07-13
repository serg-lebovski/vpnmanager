from contextlib import asynccontextmanager

import pytest

import app.providers.wg_easy as wg_easy_module
from app.providers.base import NotSupportedError, PeerSpec, ProviderAuthError
from app.providers.ssh_utils import SSHCredentials
from app.providers.wg_easy import WgEasyProvider


class FakeListener:
    def get_port(self) -> int:
        return 51999

    def close(self) -> None:
        pass


class FakeConnection:
    async def forward_local_port(self, *_args, **_kwargs) -> FakeListener:
        return FakeListener()


class FakeSSHClient:
    @asynccontextmanager
    async def connect(self, timeout: float = 20.0):
        yield FakeConnection()


class FakeResponse:
    def __init__(self, status_code: int, json_data: object = None, text: str = "", content: bytes = b"x") -> None:
        self.status_code = status_code
        self._json = json_data
        self.text = text
        self.content = content

    def json(self):
        return self._json


class FakeAsyncClient:
    """Заменяет httpx.AsyncClient: маршрутизация по (method, path) без реальной сети."""

    routes: dict[tuple, FakeResponse] = {}

    def __init__(self, base_url: str = "", timeout: float = 15.0) -> None:
        self.headers: dict[str, str] = {}
        self.base_url = base_url

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, path: str, json: dict | None = None) -> FakeResponse:
        return self.routes.get(("POST", path), FakeResponse(404))

    async def get(self, path: str) -> FakeResponse:
        return self.routes.get(("GET", path), FakeResponse(404))

    async def delete(self, path: str) -> FakeResponse:
        return self.routes.get(("DELETE", path), FakeResponse(404))


@pytest.fixture
def provider(monkeypatch) -> WgEasyProvider:
    monkeypatch.setattr(wg_easy_module.httpx, "AsyncClient", FakeAsyncClient)
    FakeAsyncClient.routes = {}
    creds = SSHCredentials(host="1.2.3.4", port=22, username="root", password="pw")
    return WgEasyProvider(
        creds, api_port=51821, api_password="secret", api_version="v15", ssh_client=FakeSSHClient()
    )


@pytest.mark.asyncio
async def test_create_peer_success(provider):
    FakeAsyncClient.routes = {
        ("POST", "/api/session"): FakeResponse(200, {"token": "tok"}),
        ("POST", "/api/wireguard/client"): FakeResponse(200, {"id": "client-1"}),
        ("GET", "/api/wireguard/client"): FakeResponse(200, [{"id": "client-1", "address": "10.0.0.5/32"}]),
        ("GET", "/api/wireguard/client/client-1/configuration"): FakeResponse(200, text="[Interface]\n..."),
    }
    result = await provider.create_peer(PeerSpec(name="X", public_key=None, preshared_key=None))
    assert result.peer_id == "client-1"
    assert result.vpn_ip == "10.0.0.5"
    assert result.private_key is None
    assert "[Interface]" in result.config_text


@pytest.mark.asyncio
async def test_authenticate_invalid_password_raises(provider):
    FakeAsyncClient.routes = {("POST", "/api/session"): FakeResponse(401)}
    with pytest.raises(ProviderAuthError):
        await provider.create_peer(PeerSpec(name="X", public_key=None, preshared_key=None))


@pytest.mark.asyncio
async def test_delete_peer(provider):
    FakeAsyncClient.routes = {
        ("POST", "/api/session"): FakeResponse(200, {"token": "tok"}),
        ("DELETE", "/api/wireguard/client/client-1"): FakeResponse(204),
    }
    await provider.delete_peer("client-1")  # не должно бросить исключение


@pytest.mark.asyncio
async def test_get_stats(provider):
    FakeAsyncClient.routes = {
        ("POST", "/api/session"): FakeResponse(200, {"token": "tok"}),
        ("GET", "/api/wireguard/client"): FakeResponse(
            200,
            [
                {
                    "id": "client-1",
                    "latestHandshakeAt": "2026-01-01T00:00:00.000Z",
                    "transferRx": 100,
                    "transferTx": 200,
                }
            ],
        ),
    }
    stats = await provider.get_stats()
    assert len(stats) == 1
    assert stats[0].rx_bytes == 100
    assert stats[0].tx_bytes == 200


@pytest.mark.asyncio
async def test_rotate_keys_not_supported(provider):
    with pytest.raises(NotSupportedError):
        await provider.rotate_keys()
