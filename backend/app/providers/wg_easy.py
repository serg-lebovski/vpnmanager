"""Провайдер wg-easy: управление через HTTP API поверх SSH local port forwarding."""

from contextlib import asynccontextmanager
from datetime import datetime

import httpx

from app.providers.base import (
    NotSupportedError,
    PeerResult,
    PeerSpec,
    PeerStat,
    ProviderAuthError,
    ProviderError,
    ProviderUnreachable,
    VPNProvider,
)
from app.providers.ssh_utils import SSHClient, SSHCredentials


class WgEasyProvider(VPNProvider):
    provider_type = "wg_easy"

    def __init__(
        self,
        creds: SSHCredentials,
        *,
        api_port: int,
        api_password: str,
        api_version: str = "v15",
        ssh_client: SSHClient | None = None,
    ) -> None:
        self._ssh = ssh_client or SSHClient(creds)
        self.api_port = api_port
        self.api_password = api_password
        self.api_version = api_version

    @asynccontextmanager
    async def _tunneled_client(self):
        """Открывает SSH local port forward на удалённый API wg-easy и авторизуется."""
        async with self._ssh.connect() as conn:
            listener = await conn.forward_local_port("127.0.0.1", 0, "127.0.0.1", self.api_port)
            local_port = listener.get_port()
            base_url = f"http://127.0.0.1:{local_port}"
            async with httpx.AsyncClient(base_url=base_url, timeout=15.0) as client:
                auth_header = await self._authenticate(client)
                if auth_header:
                    client.headers.update(auth_header)
                try:
                    yield client
                finally:
                    listener.close()

    async def _authenticate(self, client: httpx.AsyncClient) -> dict[str, str] | None:
        try:
            response = await client.post("/api/session", json={"password": self.api_password})
        except httpx.HTTPError as exc:
            raise ProviderUnreachable(f"wg-easy API unreachable: {exc}") from exc
        if response.status_code == 401:
            raise ProviderAuthError("wg-easy: invalid password")
        if response.status_code >= 400:
            raise ProviderError(f"wg-easy /api/session failed: {response.status_code}")
        if self.api_version == "v15":
            token = response.json().get("token") if response.content else None
            if token:
                return {"Authorization": f"Bearer {token}"}
        return None

    async def health_check(self) -> bool:
        try:
            async with self._tunneled_client() as client:
                response = await client.get("/api/wireguard/client")
                return response.status_code == 200
        except ProviderError:
            return False

    async def create_peer(self, spec: PeerSpec, used_ips: set[str] | None = None) -> PeerResult:
        async with self._tunneled_client() as client:
            response = await client.post("/api/wireguard/client", json={"name": spec.name})
            if response.status_code >= 400:
                raise ProviderError(f"wg-easy create client failed: {response.status_code}")
            client_id = response.json().get("id") or response.json().get("client", {}).get("id")
            if not client_id:
                raise ProviderError("wg-easy did not return a client id")

            info_response = await client.get("/api/wireguard/client")
            vpn_ip = ""
            if info_response.status_code == 200:
                for item in info_response.json():
                    if item.get("id") == client_id:
                        vpn_ip = (item.get("address") or "").split("/")[0]
                        break

            config_response = await client.get(
                f"/api/wireguard/client/{client_id}/configuration"
            )
            if config_response.status_code >= 400:
                raise ProviderError("wg-easy could not fetch client configuration")
            config_text = config_response.text

        return PeerResult(
            peer_id=str(client_id),
            vpn_ip=vpn_ip,
            config_text=config_text,
            qr_payload=config_text,
            private_key=None,
        )

    async def delete_peer(self, peer_id: str) -> None:
        async with self._tunneled_client() as client:
            response = await client.delete(f"/api/wireguard/client/{peer_id}")
            if response.status_code >= 400 and response.status_code != 404:
                raise ProviderError(f"wg-easy delete client failed: {response.status_code}")

    async def list_peers(self) -> list[PeerStat]:
        return await self.get_stats()

    async def get_stats(self) -> list[PeerStat]:
        async with self._tunneled_client() as client:
            response = await client.get("/api/wireguard/client")
            if response.status_code != 200:
                return []
            stats = []
            for item in response.json():
                handshake_raw = item.get("latestHandshakeAt")
                last_handshake = (
                    datetime.fromisoformat(handshake_raw.replace("Z", "+00:00"))
                    if handshake_raw
                    else None
                )
                stats.append(
                    PeerStat(
                        peer_id=str(item.get("id")),
                        last_handshake=last_handshake,
                        rx_bytes=int(item.get("transferRx") or 0),
                        tx_bytes=int(item.get("transferTx") or 0),
                    )
                )
            return stats

    async def rotate_keys(self) -> None:
        raise NotSupportedError("wg-easy does not support server key rotation via API")
