"""Фабрика провайдеров: строит VPNProvider для Server по сохранённым данным детекта.

Чтобы добавить новый бэкенд: реализовать VPNProvider в новом файле и добавить
одну строку в `_FACTORIES` — правки services/ не требуются.
"""

from collections.abc import Callable

from app.core.crypto import decrypt
from app.providers.amnezia_wg import AmneziaWGProvider
from app.providers.base import VPNProvider
from app.providers.ssh_utils import SSHCredentials
from app.providers.wg_easy import WgEasyProvider
from app.providers.wireguard import WireGuardProvider


def _build_ssh_credentials(server) -> SSHCredentials:
    secret = decrypt(server.ssh_credential_encrypted)
    is_private_key = "PRIVATE KEY" in secret
    return SSHCredentials(
        host=server.ssh_host,
        port=server.ssh_port,
        username=server.ssh_user,
        private_key=secret if is_private_key else None,
        password=None if is_private_key else secret,
    )


def _build_amnezia_wg(server) -> VPNProvider:
    creds = _build_ssh_credentials(server)
    obfuscation = (server.capabilities or {}).get("obfuscation")
    container_name = (server.capabilities or {}).get("container_name")
    return AmneziaWGProvider(
        creds,
        wg_interface=server.wg_interface or "awg0",
        server_public_key=server.server_public_key,
        subnet=server.subnet,
        endpoint=server.endpoint,
        wg_port=server.wg_port,
        obfuscation=obfuscation,
        container_name=container_name,
    )


def _build_wireguard(server) -> VPNProvider:
    creds = _build_ssh_credentials(server)
    return WireGuardProvider(
        creds,
        wg_interface=server.wg_interface or "wg0",
        server_public_key=server.server_public_key,
        subnet=server.subnet,
        endpoint=server.endpoint,
        wg_port=server.wg_port,
    )


def _build_wg_easy(server) -> VPNProvider:
    creds = _build_ssh_credentials(server)
    capabilities = server.capabilities or {}
    api_url = capabilities.get("api_url", "http://127.0.0.1:51821")
    api_port = int(api_url.rsplit(":", 1)[-1])
    api_password = decrypt(server.api_secret_encrypted) if server.api_secret_encrypted else ""
    return WgEasyProvider(
        creds,
        api_port=api_port,
        api_password=api_password,
        api_version=capabilities.get("api_version", "v15"),
    )


_FACTORIES: dict[str, Callable[..., VPNProvider]] = {
    "amnezia_wg": _build_amnezia_wg,
    "wg_easy": _build_wg_easy,
    "wireguard": _build_wireguard,
}


def get_provider(server) -> VPNProvider:
    """server — ORM-объект Server (или любой объект с теми же атрибутами)."""
    if not server.provider_type or server.provider_type not in _FACTORIES:
        raise ValueError(f"Unknown or undetected provider_type: {server.provider_type}")
    return _FACTORIES[server.provider_type](server)
