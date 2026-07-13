"""Общие хелперы для WireGuard-совместимых бэкендов: ключи, IP-пул, рендер .conf."""

import base64
import ipaddress
import secrets

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


def generate_keypair() -> tuple[str, str]:
    """Возвращает (private_key_b64, public_key_b64) — формат, совместимый с wg."""
    private_key = X25519PrivateKey.generate()
    private_bytes = private_key.private_bytes(
        Encoding.Raw, PrivateFormat.Raw, NoEncryption()
    )
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return (
        base64.b64encode(private_bytes).decode(),
        base64.b64encode(public_bytes).decode(),
    )


def public_key_from_private(private_key_b64: str) -> str:
    private_bytes = base64.b64decode(private_key_b64)
    private_key = X25519PrivateKey.from_private_bytes(private_bytes)
    public_bytes = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.b64encode(public_bytes).decode()


def generate_preshared_key() -> str:
    return base64.b64encode(secrets.token_bytes(32)).decode()


def next_free_ip(subnet: str, used_ips: set[str], reserve_first: bool = True) -> str:
    """Первый свободный адрес подсети (кроме адреса сети/сервера и broadcast)."""
    network = ipaddress.ip_network(subnet, strict=False)
    hosts = network.hosts()
    if reserve_first:
        next(hosts, None)  # первый хост обычно занят сервером (Address из wg0.conf)
    for host in hosts:
        candidate = str(host)
        if candidate not in used_ips:
            return candidate
    raise ValueError(f"No free IP addresses left in subnet {subnet}")


def render_client_config(
    *,
    private_key: str,
    address: str,
    dns: str | None,
    server_public_key: str,
    preshared_key: str | None,
    endpoint: str,
    endpoint_port: int,
    allowed_ips: str = "0.0.0.0/0, ::/0",
    obfuscation: dict | None = None,
) -> str:
    """Собирает клиентский .conf, при наличии obfuscation — добавляет Jc/Jmin/.../H4."""
    lines = ["[Interface]", f"PrivateKey = {private_key}", f"Address = {address}/32"]
    if dns:
        lines.append(f"DNS = {dns}")
    if obfuscation:
        for key in ("Jc", "Jmin", "Jmax", "S1", "S2", "H1", "H2", "H3", "H4"):
            if key in obfuscation and obfuscation[key] is not None:
                lines.append(f"{key} = {obfuscation[key]}")
    lines += [
        "",
        "[Peer]",
        f"PublicKey = {server_public_key}",
    ]
    if preshared_key:
        lines.append(f"PresharedKey = {preshared_key}")
    lines += [
        f"AllowedIPs = {allowed_ips}",
        f"Endpoint = {endpoint}:{endpoint_port}",
        "PersistentKeepalive = 25",
    ]
    return "\n".join(lines) + "\n"
