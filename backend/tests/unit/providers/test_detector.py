import base64

import pytest

from app.providers.base import ProviderAuthError, ProviderUnreachable
from app.providers.detector import UNSUPPORTED_MESSAGE, ServerDetector
from app.providers.ssh_utils import CommandResult, SSHCredentials

FAKE_PRIVATE_KEY = base64.b64encode(bytes(range(32))).decode()

AMNEZIA_CONF = f"""[Interface]
PrivateKey = {FAKE_PRIVATE_KEY}
Address = 10.8.0.1/24
ListenPort = 51871
Jc = 4
Jmin = 40
Jmax = 70
S1 = 68
S2 = 149
H1 = 1234567
H2 = 2345678
H3 = 3456789
H4 = 4567890
"""

WIREGUARD_CONF = f"""[Interface]
PrivateKey = {FAKE_PRIVATE_KEY}
Address = 10.9.0.1/24
ListenPort = 51820
"""


def ok(stdout: str = "") -> CommandResult:
    return CommandResult(exit_status=0, stdout=stdout, stderr="")


def fail(stderr: str = "") -> CommandResult:
    return CommandResult(exit_status=1, stdout="", stderr=stderr)


class FakeSSHRunner:
    """Отвечает на команды по точному совпадению argv; неизвестные команды -> провал."""

    def __init__(
        self,
        responses: dict[tuple, CommandResult],
        unreachable: bool = False,
        raise_error: Exception | None = None,
    ) -> None:
        self._responses = responses
        self._unreachable = unreachable
        self._raise_error = raise_error

    async def run_simple(self, argv: list[str], timeout: float = 20.0) -> CommandResult:
        if self._unreachable:
            raise ProviderUnreachable("ssh unreachable")
        if self._raise_error:
            raise self._raise_error
        key = tuple(argv)
        return self._responses.get(key, fail("command not mocked"))


def make_detector(
    responses: dict[tuple, CommandResult],
    unreachable: bool = False,
    raise_error: Exception | None = None,
) -> ServerDetector:
    creds = SSHCredentials(host="1.2.3.4", port=22, username="root", password="pw")
    runner = FakeSSHRunner(responses, unreachable=unreachable, raise_error=raise_error)
    return ServerDetector(creds, ssh_client=runner)


@pytest.mark.asyncio
async def test_ssh_unreachable():
    detector = make_detector({}, unreachable=True)
    result = await detector.detect()
    assert result.status == "UNREACHABLE"
    assert result.detection_error


@pytest.mark.asyncio
async def test_ssh_auth_failure_does_not_raise():
    """Регрессия: неверный пароль/ключ приводил к необработанному ProviderAuthError
    и 500 при добавлении сервера, вместо аккуратного статуса UNREACHABLE."""
    detector = make_detector({}, raise_error=ProviderAuthError("SSH auth failed for 1.2.3.4"))
    result = await detector.detect()
    assert result.status == "UNREACHABLE"
    assert "auth failed" in result.detection_error


@pytest.mark.asyncio
async def test_nothing_found():
    responses = {
        ("true",): ok(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"): fail(),
        ("sh", "-c", "command -v awg awg-quick"): fail(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}"): fail(),
        ("sh", "-c", "test -f /opt/amnezia/awg/wg0.conf -o -d /etc/amnezia/awg && echo yes"): fail(),
        ("sh", "-c", "command -v wg"): fail(),
    }
    detector = make_detector(responses)
    result = await detector.detect()
    assert result.status == "UNSUPPORTED"
    assert result.detection_error == UNSUPPORTED_MESSAGE


@pytest.mark.asyncio
async def test_amnezia_bare_metal():
    responses = {
        ("true",): ok(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"): fail(),
        ("sh", "-c", "command -v awg awg-quick"): ok("/usr/bin/awg\n/usr/bin/awg-quick"),
        ("cat", "/opt/amnezia/awg/wg0.conf"): ok(AMNEZIA_CONF),
        ("sh", "-c", "command -v wg"): fail(),
    }
    detector = make_detector(responses)
    result = await detector.detect()
    assert result.status == "ONLINE"
    assert result.provider_type == "amnezia_wg"
    assert result.wg_port == 51871
    assert result.subnet == "10.8.0.1/24"
    assert result.capabilities["obfuscation"]["Jc"] == 4
    assert result.capabilities["container_name"] is None
    assert result.server_public_key


@pytest.mark.asyncio
async def test_amnezia_docker():
    responses = {
        ("true",): ok(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"): fail(),
        ("sh", "-c", "command -v awg awg-quick"): fail(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}"): ok("amnezia/amnezia-awg:latest\tamnezia-awg"),
        ("docker", "exec", "amnezia-awg", "cat", "/opt/amnezia/awg/wg0.conf"): ok(AMNEZIA_CONF),
        ("sh", "-c", "command -v wg"): fail(),
    }
    detector = make_detector(responses)
    result = await detector.detect()
    assert result.status == "ONLINE"
    assert result.provider_type == "amnezia_wg"
    assert result.capabilities["container_name"] == "amnezia-awg"


@pytest.mark.asyncio
async def test_wg_easy_docker():
    responses = {
        ("true",): ok(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"): ok(
            "ghcr.io/wg-easy/wg-easy\twg-easy\t0.0.0.0:51821->51821/tcp, 0.0.0.0:51820->51820/udp"
        ),
        ("docker", "inspect", "wg-easy"): ok('["WG_HOST=vpn.example.com", "PASSWORD_HASH=abc"]'),
        (
            "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5",
            "http://127.0.0.1:51821/api/session",
        ): ok("200"),
    }
    detector = make_detector(responses)
    result = await detector.detect()
    assert result.status == "ONLINE"
    assert result.provider_type == "wg_easy"
    assert result.wg_port == 51820
    assert result.capabilities["api_version"] == "v15"
    assert result.capabilities["container_name"] == "wg-easy"


@pytest.mark.asyncio
async def test_plain_wireguard():
    responses = {
        ("true",): ok(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"): fail(),
        ("sh", "-c", "command -v awg awg-quick"): fail(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}"): fail(),
        ("sh", "-c", "test -f /opt/amnezia/awg/wg0.conf -o -d /etc/amnezia/awg && echo yes"): fail(),
        ("sh", "-c", "command -v wg"): ok("/usr/bin/wg"),
        ("wg", "show", "interfaces"): ok("wg0"),
        ("cat", "/etc/wireguard/wg0.conf"): ok(WIREGUARD_CONF),
    }
    detector = make_detector(responses)
    result = await detector.detect()
    assert result.status == "ONLINE"
    assert result.provider_type == "wireguard"
    assert result.wg_interface == "wg0"
    assert result.wg_port == 51820
    assert result.capabilities["obfuscation"] is None


@pytest.mark.asyncio
async def test_priority_wg_easy_over_amnezia_records_also_found():
    responses = {
        ("true",): ok(),
        ("docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"): ok(
            "ghcr.io/wg-easy/wg-easy\twg-easy\t0.0.0.0:51821->51821/tcp, 0.0.0.0:51820->51820/udp"
        ),
        ("docker", "inspect", "wg-easy"): ok('["PASSWORD=secret"]'),
        (
            "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5",
            "http://127.0.0.1:51821/api/session",
        ): ok("200"),
        ("sh", "-c", "command -v awg awg-quick"): ok("/usr/bin/awg"),
        ("cat", "/opt/amnezia/awg/wg0.conf"): ok(AMNEZIA_CONF),
    }
    detector = make_detector(responses)
    result = await detector.detect()
    assert result.provider_type == "wg_easy"
    assert result.capabilities["also_found"] == ["amnezia_wg"]
