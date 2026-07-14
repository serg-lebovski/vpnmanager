import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.models.config import Config
from app.models.organization import Organization
from app.repositories.configs import ConfigRepository
from app.repositories.organizations import OrganizationRepository
from app.repositories.servers import ServerRepository
from app.schemas.organizations import OrganizationCreateRequest, OrganizationUpdateRequest
from app.services.audit import AuditService


class OrganizationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = OrganizationRepository(session)
        self.servers = ServerRepository(session)
        self.configs = ConfigRepository(session)
        self.audit = AuditService(session)

    async def get_or_404(self, org_id: uuid.UUID) -> Organization:
        org = await self.repo.get_by_id(org_id)
        if not org:
            raise NotFoundError("Организация не найдена")
        return org

    async def list_all(self) -> list[Organization]:
        return await self.repo.list_all()

    async def create(
        self, data: OrganizationCreateRequest, actor_id: uuid.UUID | None, actor_ip: str | None
    ) -> Organization:
        if await self.repo.get_by_name(data.name):
            raise ConflictError("Организация с таким названием уже существует")
        org = Organization(name=data.name, auto_cleanup_days=data.auto_cleanup_days)
        self.repo.add(org)
        await self.session.flush()
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="CREATE",
            target_type="ORG", target_id=org.id, details={"name": org.name},
        )
        await self.session.commit()
        await self.session.refresh(org)
        return org

    async def update(
        self,
        org_id: uuid.UUID,
        data: OrganizationUpdateRequest,
        actor_id: uuid.UUID | None = None,
        actor_ip: str | None = None,
    ) -> Organization:
        org = await self.get_or_404(org_id)
        if data.name is not None:
            org.name = data.name
        if data.auto_cleanup_days is not None:
            org.auto_cleanup_days = data.auto_cleanup_days
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="UPDATE",
            target_type="ORG", target_id=org.id,
        )
        await self.session.commit()
        await self.session.refresh(org)
        return org

    async def delete(
        self, org_id: uuid.UUID, actor_id: uuid.UUID | None = None, actor_ip: str | None = None
    ) -> None:
        org = await self.get_or_404(org_id)
        if await self.repo.count_users(org_id) > 0:
            raise ConflictError("Нельзя удалить организацию, в которой есть пользователи")
        await self.repo.delete(org)
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="DELETE",
            target_type="ORG", target_id=org_id,
        )
        await self.session.commit()

    async def set_servers(
        self,
        org_id: uuid.UUID,
        server_ids: list[uuid.UUID],
        actor_id: uuid.UUID | None = None,
        actor_ip: str | None = None,
    ) -> None:
        await self.get_or_404(org_id)
        await self.repo.replace_server_links(org_id, server_ids)
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="UPDATE",
            target_type="ORG", target_id=org_id,
            details={"server_ids": [str(s) for s in server_ids]},
        )
        await self.session.commit()

    async def stats(self, org_id: uuid.UUID) -> dict:
        await self.get_or_404(org_id)
        server_ids = await self.repo.list_server_ids(org_id)
        configs: list[Config] = []
        for server_id in server_ids:
            configs += await self.configs.list_all(server_id=server_id)
        users_count = await self.repo.count_users(org_id)
        return {
            "servers_count": len(server_ids),
            "users_count": users_count,
            "configs_count": len(configs),
            "configs_active": len([c for c in configs if not c.is_revoked]),
        }
