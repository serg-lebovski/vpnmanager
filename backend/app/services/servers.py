import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import encrypt
from app.core.exceptions import ConflictError, NotFoundError
from app.models.server import Server
from app.providers.base import NotSupportedError, ProviderError
from app.providers.detector import ServerDetector
from app.providers.registry import get_provider
from app.providers.ssh_utils import SSHCredentials
from app.repositories.servers import ServerRepository
from app.schemas.servers import ServerCreateRequest, ServerUpdateRequest
from app.services.audit import AuditService


class ServerService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = ServerRepository(session)
        self.audit = AuditService(session)

    async def get_or_404(self, server_id: uuid.UUID) -> Server:
        server = await self.repo.get_by_id(server_id)
        if not server:
            raise NotFoundError("Сервер не найден")
        return server

    async def list_all(self) -> list[Server]:
        return await self.repo.list_all()

    async def create(
        self, data: ServerCreateRequest, actor_id: uuid.UUID | None, actor_ip: str | None
    ) -> Server:
        secret = data.ssh_private_key or data.ssh_password or ""
        server = Server(
            name=data.name,
            endpoint=data.endpoint,
            status="PENDING",
            ssh_host=data.endpoint,
            ssh_port=data.ssh_port,
            ssh_user=data.ssh_user,
            ssh_credential_encrypted=encrypt(secret),
            api_secret_encrypted=encrypt(data.wg_easy_password) if data.wg_easy_password else None,
        )
        self.repo.add(server)
        await self.session.flush()

        await self._run_detection(server, wg_easy_password_hint=data.wg_easy_password)

        self.audit.log(
            actor_user_id=actor_id,
            actor_ip=actor_ip,
            action="CREATE",
            target_type="SERVER",
            target_id=server.id,
            details={"name": server.name, "endpoint": server.endpoint},
        )
        await self.session.commit()
        await self.session.refresh(server)
        return server

    async def redetect(
        self, server_id: uuid.UUID, actor_id: uuid.UUID | None, actor_ip: str | None
    ) -> Server:
        server = await self.get_or_404(server_id)
        await self._run_detection(server)
        self.audit.log(
            actor_user_id=actor_id,
            actor_ip=actor_ip,
            action="DETECT",
            target_type="SERVER",
            target_id=server.id,
            details={"provider_type": server.provider_type, "status": server.status},
        )
        await self.session.commit()
        await self.session.refresh(server)
        return server

    async def _run_detection(self, server: Server, wg_easy_password_hint: str | None = None) -> None:
        from app.core.crypto import decrypt

        secret = decrypt(server.ssh_credential_encrypted)
        is_private_key = "PRIVATE KEY" in secret
        creds = SSHCredentials(
            host=server.ssh_host,
            port=server.ssh_port,
            username=server.ssh_user,
            private_key=secret if is_private_key else None,
            password=None if is_private_key else secret,
        )
        detector = ServerDetector(creds)
        result = await detector.detect()

        server.status = result.status
        server.provider_type = result.provider_type
        server.wg_interface = result.wg_interface
        server.wg_port = result.wg_port
        server.server_public_key = result.server_public_key
        server.subnet = result.subnet
        server.capabilities = result.capabilities
        server.detected_at = result.detected_at
        server.detection_error = result.detection_error
        server.last_checked_at = datetime.now(UTC)

        if result.provider_type == "wg_easy" and wg_easy_password_hint:
            server.api_secret_encrypted = encrypt(wg_easy_password_hint)

    async def update(
        self,
        server_id: uuid.UUID,
        data: ServerUpdateRequest,
        actor_id: uuid.UUID | None = None,
        actor_ip: str | None = None,
    ) -> Server:
        server = await self.get_or_404(server_id)
        if data.name is not None:
            server.name = data.name
        if data.weight is not None:
            server.weight = data.weight
        if data.max_peers is not None:
            server.max_peers = data.max_peers
        if data.is_active is not None:
            server.is_active = data.is_active
        if data.ssh_private_key or data.ssh_password:
            server.ssh_credential_encrypted = encrypt(data.ssh_private_key or data.ssh_password or "")
        if data.wg_easy_password:
            server.api_secret_encrypted = encrypt(data.wg_easy_password)
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="UPDATE",
            target_type="SERVER", target_id=server.id,
        )
        await self.session.commit()
        await self.session.refresh(server)
        return server

    async def delete(
        self, server_id: uuid.UUID, actor_id: uuid.UUID | None = None, actor_ip: str | None = None
    ) -> None:
        server = await self.get_or_404(server_id)
        if await self.repo.is_linked_to_org(server_id):
            raise ConflictError(
                "Нельзя удалить сервер, привязанный к организации — сначала отвяжите его "
                "на странице «Организации»"
            )
        await self.repo.delete(server)
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="DELETE",
            target_type="SERVER", target_id=server_id,
        )
        await self.session.commit()

    async def test(self, server_id: uuid.UUID) -> bool:
        server = await self.get_or_404(server_id)
        if not server.provider_type:
            return False
        provider = get_provider(server)
        healthy = await provider.health_check()
        server.status = "ONLINE" if healthy else "OFFLINE"
        server.last_checked_at = datetime.now(UTC)
        await self.session.commit()
        return healthy

    async def rotate_keys(
        self, server_id: uuid.UUID, actor_id: uuid.UUID | None = None, actor_ip: str | None = None
    ) -> None:
        server = await self.get_or_404(server_id)
        provider = get_provider(server)
        try:
            await provider.rotate_keys()
        except NotSupportedError:
            raise
        except ProviderError as exc:
            raise ConflictError(str(exc)) from exc
        server.server_public_key = getattr(provider, "server_public_key", server.server_public_key)
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="UPDATE",
            target_type="SERVER", target_id=server.id, details={"rotate_keys": True},
        )
        await self.session.commit()
