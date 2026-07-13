import pytest

from app.providers.wg_utils import (
    generate_keypair,
    generate_preshared_key,
    next_free_ip,
    public_key_from_private,
    render_client_config,
)


def test_generate_keypair_derives_matching_public_key():
    private_key, public_key = generate_keypair()
    assert public_key_from_private(private_key) == public_key


def test_generate_preshared_key_is_base64_32_bytes():
    import base64

    psk = generate_preshared_key()
    assert len(base64.b64decode(psk)) == 32


def test_next_free_ip_skips_used_and_reserved():
    used = {"10.8.0.2"}
    ip = next_free_ip("10.8.0.0/24", used)
    assert ip == "10.8.0.3"


def test_next_free_ip_raises_when_exhausted():
    network_ips = {f"10.8.0.{i}" for i in range(2, 255)}
    with pytest.raises(ValueError):
        next_free_ip("10.8.0.0/24", network_ips)


def test_render_client_config_includes_obfuscation_params():
    config = render_client_config(
        private_key="priv",
        address="10.8.0.5",
        dns="1.1.1.1",
        server_public_key="pub",
        preshared_key="psk",
        endpoint="vpn.example.com",
        endpoint_port=51871,
        obfuscation={"Jc": 4, "Jmin": 40, "Jmax": 70, "S1": 68, "S2": 149, "H1": 1, "H2": 2, "H3": 3, "H4": 4},
    )
    assert "Jc = 4" in config
    assert "H4 = 4" in config
    assert "PresharedKey = psk" in config
    assert "Endpoint = vpn.example.com:51871" in config


def test_render_client_config_without_obfuscation():
    config = render_client_config(
        private_key="priv",
        address="10.8.0.5",
        dns=None,
        server_public_key="pub",
        preshared_key=None,
        endpoint="vpn.example.com",
        endpoint_port=51820,
    )
    assert "Jc" not in config
    assert "PresharedKey" not in config
