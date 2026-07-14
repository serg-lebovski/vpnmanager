"""Общий SSH-клиент для провайдеров: подключение, TOFU known_hosts, безопасный запуск команд."""

import asyncio
import shlex
from collections.abc import Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import asyncssh

from app.config import get_settings
from app.providers.base import ProviderAuthError, ProviderUnreachable


@dataclass
class SSHCredentials:
    host: str
    port: int
    username: str
    private_key: str | None = None
    password: str | None = None


@dataclass
class CommandResult:
    exit_status: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.exit_status == 0


def _ensure_known_hosts_file(path: str) -> None:
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    if not file_path.exists():
        file_path.touch(mode=0o600)


def _append_known_host(path: str, entry: str) -> None:
    with open(path, "a") as f:
        f.write(entry)


def _known_hosts_entry(host: str, port: int, host_key: asyncssh.SSHKey) -> str:
    pubkey_line = host_key.export_public_key(format_name="openssh").decode().strip()
    algo, keydata = pubkey_line.split(" ")[:2]
    host_pattern = f"[{host}]:{port}" if port != 22 else host
    return f"{host_pattern} {algo} {keydata}\n"


class SSHClient:
    """Тонкая обёртка над asyncssh.connect с TOFU-принятием ключей хоста (раздел 11 ТЗ):
    первое подключение к незнакомому хосту принимает его ключ и запоминает в known_hosts,
    последующие подключения проверяются строго по этому файлу."""

    def __init__(self, creds: SSHCredentials) -> None:
        self._creds = creds

    def _base_connect_kwargs(self, timeout: float) -> dict:
        kwargs: dict = {
            "host": self._creds.host,
            "port": self._creds.port,
            "username": self._creds.username,
            "connect_timeout": timeout,
        }
        if self._creds.private_key:
            kwargs["client_keys"] = [asyncssh.import_private_key(self._creds.private_key)]
        elif self._creds.password:
            kwargs["password"] = self._creds.password
        return kwargs

    @asynccontextmanager
    async def connect(self, timeout: float = 20.0):
        settings = get_settings()
        known_hosts_path = settings.ssh_known_hosts_path
        _ensure_known_hosts_file(known_hosts_path)

        base_kwargs = self._base_connect_kwargs(timeout)
        try:
            try:
                async with asyncssh.connect(known_hosts=known_hosts_path, **base_kwargs) as conn:
                    yield conn
                    return
            except asyncssh.HostKeyNotVerifiable:
                # TOFU: хост ещё не в known_hosts — принимаем ключ и запоминаем его.
                async with asyncssh.connect(known_hosts=None, **base_kwargs) as conn:
                    host_key = conn.get_server_host_key()
                    if host_key is not None:
                        entry = _known_hosts_entry(self._creds.host, self._creds.port, host_key)
                        await asyncio.to_thread(_append_known_host, known_hosts_path, entry)
                    yield conn
        except asyncssh.PermissionDenied as exc:
            raise ProviderAuthError(f"SSH auth failed for {self._creds.host}") from exc
        except (asyncssh.Error, OSError, TimeoutError) as exc:
            raise ProviderUnreachable(f"SSH connection to {self._creds.host} failed: {exc}") from exc

    async def run(self, conn: asyncssh.SSHClientConnection, argv: Sequence[str]) -> CommandResult:
        """Выполняет команду по списку аргументов (без интерполяции в shell)."""
        command = " ".join(shlex.quote(part) for part in argv)
        result = await conn.run(command, check=False)
        return CommandResult(
            exit_status=result.exit_status or 0,
            stdout=str(result.stdout or ""),
            stderr=str(result.stderr or ""),
        )

    async def run_simple(self, argv: Sequence[str], timeout: float = 20.0) -> CommandResult:
        async with self.connect(timeout=timeout) as conn:
            return await self.run(conn, argv)
