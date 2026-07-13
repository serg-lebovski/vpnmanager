import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.download_token import DownloadToken


class DownloadTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_token(self, token: uuid.UUID) -> DownloadToken | None:
        result = await self.session.execute(
            select(DownloadToken).where(DownloadToken.token == token)
        )
        return result.scalar_one_or_none()

    def add(self, token: DownloadToken) -> None:
        self.session.add(token)
