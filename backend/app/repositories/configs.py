import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config import Config


class ConfigRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, config_id: uuid.UUID) -> Config | None:
        return await self.session.get(Config, config_id)

    async def list_all(
        self,
        user_id: uuid.UUID | None = None,
        org_user_ids: list[uuid.UUID] | None = None,
        server_id: uuid.UUID | None = None,
        include_revoked: bool = True,
    ) -> list[Config]:
        stmt = select(Config).order_by(Config.created_at.desc())
        if user_id is not None:
            stmt = stmt.where(Config.user_id == user_id)
        if org_user_ids is not None:
            stmt = stmt.where(Config.user_id.in_(org_user_ids))
        if server_id is not None:
            stmt = stmt.where(Config.server_id == server_id)
        if not include_revoked:
            stmt = stmt.where(Config.is_revoked.is_(False))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    def add(self, config: Config) -> None:
        self.session.add(config)

    async def delete(self, config: Config) -> None:
        await self.session.delete(config)
