import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config import Config
from app.models.organization import OrganizationServer
from app.models.server import Server


class ServerRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, server_id: uuid.UUID) -> Server | None:
        return await self.session.get(Server, server_id)

    async def list_all(self) -> list[Server]:
        result = await self.session.execute(select(Server).order_by(Server.name))
        return list(result.scalars().all())

    async def list_by_ids(self, server_ids: list[uuid.UUID]) -> list[Server]:
        if not server_ids:
            return []
        result = await self.session.execute(select(Server).where(Server.id.in_(server_ids)))
        return list(result.scalars().all())

    async def is_linked_to_org(self, server_id: uuid.UUID) -> bool:
        result = await self.session.execute(
            select(func.count())
            .select_from(OrganizationServer)
            .where(OrganizationServer.server_id == server_id)
        )
        return int(result.scalar_one()) > 0

    async def active_configs_count(self, server_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count())
            .select_from(Config)
            .where(Config.server_id == server_id, Config.is_revoked.is_(False))
        )
        return int(result.scalar_one())

    async def used_ips(self, server_id: uuid.UUID) -> set[str]:
        result = await self.session.execute(
            select(Config.vpn_ip).where(Config.server_id == server_id)
        )
        return set(result.scalars().all())

    def add(self, server: Server) -> None:
        self.session.add(server)

    async def delete(self, server: Server) -> None:
        await self.session.delete(server)
