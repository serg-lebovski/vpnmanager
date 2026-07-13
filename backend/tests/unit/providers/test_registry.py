from types import SimpleNamespace

import pytest

from app.core.crypto import encrypt
from app.providers.amnezia_wg import AmneziaWGProvider
from app.providers.registry import get_provider
from app.providers.wg_easy import WgEasyProvider
from app.providers.wireguard import WireGuardProvider


def make_server(**overrides) -> SimpleNamespace:
    defaults = dict(
        provider_type="wireguard",
        ssh_host="1.2.3.4",
        ssh_port=22,
        ssh_user="root",
        ssh_credential_encrypted=encrypt("password"),
        api_secret_encrypted=None,
        wg_interface="wg0",
        server_public_key="pub",
        subnet="10.9.0.0/24",
        endpoint="vpn.example.com",
        wg_port=51820,
        capabilities={},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_get_provider_wireguard():
    server = make_server(provider_type="wireguard")
    provider = get_provider(server)
    assert isinstance(provider, WireGuardProvider)


def test_get_provider_amnezia_wg():
    server = make_server(
        provider_type="amnezia_wg", capabilities={"obfuscation": {"Jc": 4}, "container_name": None}
    )
    provider = get_provider(server)
    assert isinstance(provider, AmneziaWGProvider)
    assert provider.obfuscation == {"Jc": 4}


def test_get_provider_wg_easy():
    server = make_server(
        provider_type="wg_easy",
        api_secret_encrypted=encrypt("wgpass"),
        capabilities={"api_url": "http://127.0.0.1:51821", "api_version": "v15"},
    )
    provider = get_provider(server)
    assert isinstance(provider, WgEasyProvider)
    assert provider.api_port == 51821
    assert provider.api_password == "wgpass"


def test_get_provider_unknown_raises():
    server = make_server(provider_type=None)
    with pytest.raises(ValueError):
        get_provider(server)


def test_ssh_private_key_detected_over_password():
    secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
    server = make_server(ssh_credential_encrypted=encrypt(secret))
    provider = get_provider(server)
    assert isinstance(provider, WireGuardProvider)
