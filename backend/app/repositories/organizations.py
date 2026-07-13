import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.organization import Organization, OrganizationServer
from app.models.server import Server
from app.models.user import User


class OrganizationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(
        self, org_id: uuid.UUID, with_servers: bool = False
    ) -> Organization | None:
        stmt = select(Organization).where(Organization.id == org_id)
        if with_servers:
            stmt = stmt.options(selectinload(Organization.server_links).selectinload(
                OrganizationServer.server
            ))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_name(self, name: str) -> Organization | None:
        result = await self.session.execute(select(Organization).where(Organization.name == name))
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Organization]:
        result = await self.session.execute(select(Organization).order_by(Organization.name))
        return list(result.scalars().all())

    async def count_users(self, org_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count()).select_from(User).where(User.org_id == org_id)
        )
        return int(result.scalar_one())

    async def list_server_ids(self, org_id: uuid.UUID) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(OrganizationServer.server_id).where(OrganizationServer.org_id == org_id)
        )
        return list(result.scalars().all())

    async def get_servers(self, org_id: uuid.UUID) -> list[Server]:
        result = await self.session.execute(
            select(Server)
            .join(OrganizationServer, OrganizationServer.server_id == Server.id)
            .where(OrganizationServer.org_id == org_id)
        )
        return list(result.scalars().all())

    async def replace_server_links(self, org_id: uuid.UUID, server_ids: list[uuid.UUID]) -> None:
        await self.session.execute(
            delete(OrganizationServer).where(OrganizationServer.org_id == org_id)
        )
        for server_id in server_ids:
            self.session.add(OrganizationServer(org_id=org_id, server_id=server_id))

    def add(self, org: Organization) -> None:
        self.session.add(org)

    async def delete(self, org: Organization) -> None:
        await self.session.delete(org)
