import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config import Config
from app.models.user import User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self.session.get(User, user_id)

    async def get_by_username(self, username: str) -> User | None:
        result = await self.session.execute(select(User).where(User.username == username))
        return result.scalar_one_or_none()

    async def count_by_role(self, role: str) -> int:
        result = await self.session.execute(
            select(func.count()).select_from(User).where(User.role == role)
        )
        return int(result.scalar_one())

    async def list_all(
        self, org_id: uuid.UUID | None = None, query: str | None = None
    ) -> list[tuple[User, int]]:
        stmt = (
            select(User, func.count(Config.id))
            .outerjoin(Config, Config.user_id == User.id)
            .group_by(User.id)
            .order_by(User.username)
        )
        if org_id is not None:
            stmt = stmt.where(User.org_id == org_id)
        if query:
            like = f"%{query}%"
            stmt = stmt.where(
                (User.username.ilike(like)) | (User.full_name.ilike(like))
            )
        result = await self.session.execute(stmt)
        return [(row[0], row[1]) for row in result.all()]

    def add(self, user: User) -> None:
        self.session.add(user)

    async def delete(self, user: User) -> None:
        await self.session.delete(user)
