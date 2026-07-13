"""Единый контракт VPN-провайдеров. Сервисный слой знает ТОЛЬКО этот интерфейс."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class PeerSpec:
    """Что нужно, чтобы создать пира."""

    name: str
    public_key: str | None
    preshared_key: str | None


@dataclass(frozen=True)
class PeerResult:
    """Что провайдер вернул после создания."""

    peer_id: str
    vpn_ip: str
    config_text: str
    qr_payload: str
    private_key: str | None = None


@dataclass(frozen=True)
class PeerStat:
    peer_id: str
    last_handshake: datetime | None
    rx_bytes: int
    tx_bytes: int


class ProviderError(Exception):
    """Базовая ошибка провайдера."""


class ProviderUnreachable(ProviderError):
    """Сервер недоступен (SSH/HTTP не отвечает)."""


class ProviderAuthError(ProviderError):
    """Неверные учётные данные (SSH-ключ/пароль, API-пароль)."""


class NotSupportedError(ProviderError):
    """Операция не поддерживается данным типом бэкенда."""


class VPNProvider(ABC):
    """Единый контракт. Сервисный слой знает ТОЛЬКО этот интерфейс."""

    provider_type: str

    @abstractmethod
    async def health_check(self) -> bool: ...

    @abstractmethod
    async def create_peer(self, spec: PeerSpec, used_ips: set[str] | None = None) -> PeerResult:
        """used_ips используется только провайдерами, которые сами выбирают IP
        (amnezia_wg/wireguard); wg-easy назначает адрес самостоятельно и игнорирует его."""

    @abstractmethod
    async def delete_peer(self, peer_id: str) -> None: ...

    @abstractmethod
    async def list_peers(self) -> list[PeerStat]: ...

    @abstractmethod
    async def get_stats(self) -> list[PeerStat]: ...

    @abstractmethod
    async def rotate_keys(self) -> None:
        """Опционально; если не поддерживается — raise NotSupportedError."""
