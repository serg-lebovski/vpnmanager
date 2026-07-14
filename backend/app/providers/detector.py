"""Автоопределение типа VPN-бэкенда на сервере (раздел 5.2 ТЗ)."""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

from app.providers.base import ProviderError
from app.providers.ssh_utils import CommandResult, SSHClient, SSHCredentials

PRIORITY = ("wg_easy", "amnezia_wg", "wireguard")

UNSUPPORTED_MESSAGE = "VPN-сервер не обнаружен (искали: AmneziaWG, wg-easy, WireGuard)"


class SSHRunner(Protocol):
    async def run_simple(self, argv: list[str], timeout: float = 20.0) -> CommandResult: ...


@dataclass
class DetectionResult:
    status: str  # ONLINE | UNREACHABLE | UNSUPPORTED
    provider_type: str | None = None
    wg_interface: str | None = None
    wg_port: int | None = None
    server_public_key: str | None = None
    subnet: str | None = None
    capabilities: dict = field(default_factory=dict)
    detection_error: str | None = None
    detected_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def _parse_wg_conf(text: str) -> dict:
    """Парсит секцию [Interface] wg0.conf/awg0.conf: ListenPort, PrivateKey, Address, Jc..H4."""
    result: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        result[key.strip()] = value.strip()
    return result


def _obfuscation_from_conf(parsed: dict) -> dict | None:
    keys = ("Jc", "Jmin", "Jmax", "S1", "S2", "H1", "H2", "H3", "H4")
    if not any(k in parsed for k in keys):
        return None
    obf = {}
    for k in keys:
        if k in parsed:
            try:
                obf[k] = int(parsed[k])
            except ValueError:
                obf[k] = parsed[k]
    return obf


class ServerDetector:
    """Запускает цепочку проверок по SSH и определяет тип VPN-бэкенда."""

    def __init__(self, creds: SSHCredentials, ssh_client: SSHRunner | None = None) -> None:
        self._creds = creds
        self._ssh = ssh_client or SSHClient(creds)

    async def detect(self) -> DetectionResult:
        try:
            await self._ssh.run_simple(["true"], timeout=20.0)
        except ProviderError as exc:
            # Недоступен хост, неверный пароль/ключ и т.п. — по разделу 5.2 ТЗ
            # любой провал SSH-подключения даёт UNREACHABLE с текстом ошибки,
            # а не падение запроса (ProviderAuthError — тоже ProviderError).
            return DetectionResult(status="UNREACHABLE", detection_error=str(exc))

        found: dict[str, DetectionResult] = {}

        wg_easy_result = await self._check_wg_easy()
        if wg_easy_result:
            found["wg_easy"] = wg_easy_result

        amnezia_result = await self._check_amnezia_wg()
        if amnezia_result:
            found["amnezia_wg"] = amnezia_result

        wireguard_result = await self._check_wireguard()
        if wireguard_result:
            found["wireguard"] = wireguard_result

        if not found:
            return DetectionResult(status="UNSUPPORTED", detection_error=UNSUPPORTED_MESSAGE)

        winner_type = next(p for p in PRIORITY if p in found)
        winner = found[winner_type]
        also_found = [p for p in found if p != winner_type]
        if also_found:
            winner.capabilities["also_found"] = also_found
        winner.status = "ONLINE"
        return winner

    async def _check_wg_easy(self) -> DetectionResult | None:
        ps = await self._ssh.run_simple(["docker", "ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"])
        if not ps.ok:
            return None
        container_name = None
        for line in ps.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            image, name = parts[0], parts[1]
            if "wg-easy" in image:
                container_name = name
                break
        if not container_name:
            return None

        inspect = await self._ssh.run_simple(["docker", "inspect", container_name])
        env_text = inspect.stdout if inspect.ok else ""
        env = self._parse_docker_env(env_text)

        http_port = self._extract_published_port(ps.stdout, container_name, default=51821)

        check = await self._ssh.run_simple(
            [
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "--max-time",
                "5",
                f"http://127.0.0.1:{http_port}/api/session",
            ]
        )
        http_code = check.stdout.strip() if check.ok else ""
        if not http_code or http_code.startswith("000"):
            return None

        api_version = "v15" if "PASSWORD_HASH" in env or "PASSWORD" not in env else "v14"

        capabilities = {
            "obfuscation": None,
            "api_version": api_version,
            "api_url": f"http://127.0.0.1:{http_port}",
            "supports_key_rotation": False,
            "container_name": container_name,
        }
        wg_port = None
        port_match = re.search(r"(\d+)/udp", ps.stdout)
        if port_match:
            wg_port = int(port_match.group(1))

        return DetectionResult(
            status="PENDING",
            provider_type="wg_easy",
            wg_port=wg_port,
            capabilities=capabilities,
        )

    async def _check_amnezia_wg(self) -> DetectionResult | None:
        container_name = None
        which = await self._ssh.run_simple(["sh", "-c", "command -v awg awg-quick"])
        bare_metal = which.ok and which.stdout.strip() != ""

        if not bare_metal:
            ps = await self._ssh.run_simple(
                ["docker", "ps", "--format", "{{.Image}}\t{{.Names}}"]
            )
            if ps.ok:
                for line in ps.stdout.splitlines():
                    parts = line.split("\t")
                    if len(parts) < 2:
                        continue
                    image, name = parts[0], parts[1]
                    if "amnezia" in image.lower():
                        container_name = name
                        break

        if not bare_metal and not container_name:
            check_path = await self._ssh.run_simple(
                ["sh", "-c", "test -f /opt/amnezia/awg/wg0.conf -o -d /etc/amnezia/awg && echo yes"]
            )
            if not (check_path.ok and "yes" in check_path.stdout):
                return None

        conf_text = await self._read_interface_conf(
            container_name,
            candidates=["/opt/amnezia/awg/wg0.conf", "/etc/amnezia/awg/wg0.conf"],
        )
        if conf_text is None:
            return None

        return self._build_result_from_conf(
            "amnezia_wg", conf_text, container_name, wg_interface="awg0"
        )

    async def _check_wireguard(self) -> DetectionResult | None:
        which = await self._ssh.run_simple(["sh", "-c", "command -v wg"])
        if not (which.ok and which.stdout.strip()):
            return None
        show = await self._ssh.run_simple(["wg", "show", "interfaces"])
        if not (show.ok and show.stdout.strip()):
            return None
        iface = show.stdout.split()[0]
        conf_text = await self._read_interface_conf(None, candidates=[f"/etc/wireguard/{iface}.conf"])
        if conf_text is None:
            return None
        return self._build_result_from_conf("wireguard", conf_text, None, wg_interface=iface)

    async def _read_interface_conf(
        self, container_name: str | None, candidates: list[str]
    ) -> str | None:
        for path in candidates:
            if container_name:
                result = await self._ssh.run_simple(["docker", "exec", container_name, "cat", path])
            else:
                result = await self._ssh.run_simple(["cat", path])
            if result.ok and result.stdout.strip():
                return result.stdout
        return None

    def _build_result_from_conf(
        self, provider_type: str, conf_text: str, container_name: str | None, wg_interface: str
    ) -> DetectionResult:
        from app.providers.wg_utils import public_key_from_private

        parsed = _parse_wg_conf(conf_text)
        private_key = parsed.get("PrivateKey")
        server_public_key = public_key_from_private(private_key) if private_key else None
        wg_port = int(parsed["ListenPort"]) if "ListenPort" in parsed else None
        subnet = parsed.get("Address")

        capabilities = {
            "obfuscation": _obfuscation_from_conf(parsed) if provider_type == "amnezia_wg" else None,
            "api_version": None,
            "supports_key_rotation": True,
            "container_name": container_name,
        }
        return DetectionResult(
            status="PENDING",
            provider_type=provider_type,
            wg_interface=wg_interface,
            wg_port=wg_port,
            server_public_key=server_public_key,
            subnet=subnet,
            capabilities=capabilities,
        )

    @staticmethod
    def _parse_docker_env(inspect_json_text: str) -> dict[str, str]:
        env: dict[str, str] = {}
        for match in re.finditer(r'"([A-Z_]+)=([^"]*)"', inspect_json_text):
            env[match.group(1)] = match.group(2)
        return env

    @staticmethod
    def _extract_published_port(ps_line: str, container_name: str, default: int) -> int:
        for line in ps_line.splitlines():
            if container_name not in line:
                continue
            match = re.search(r":(\d+)->\d+/tcp", line)
            if match:
                return int(match.group(1))
        return default
