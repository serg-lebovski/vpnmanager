"""Общий SSH-клиент для провайдеров: подключение, TOFU known_hosts, безопасный запуск команд."""

import shlex
from collections.abc import Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass

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


class SSHClient:
    """Тонкая обёртка над asyncssh.connect с TOFU-принятием ключей хоста."""

    def __init__(self, creds: SSHCredentials) -> None:
        self._creds = creds

    @asynccontextmanager
    async def connect(self, timeout: float = 20.0):
        settings = get_settings()
        connect_kwargs: dict = {
            "host": self._creds.host,
            "port": self._creds.port,
            "username": self._creds.username,
            "known_hosts": settings.ssh_known_hosts_path,
            "connect_timeout": timeout,
        }
        if self._creds.private_key:
            connect_kwargs["client_keys"] = [
                asyncssh.import_private_key(self._creds.private_key)
            ]
        elif self._creds.password:
            connect_kwargs["password"] = self._creds.password
        try:
            async with asyncssh.connect(**connect_kwargs) as conn:
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
