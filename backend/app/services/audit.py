import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog
from app.repositories.audit_logs import AuditLogRepository


class AuditService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = AuditLogRepository(session)

    def log(
        self,
        *,
        actor_user_id: uuid.UUID | None,
        actor_ip: str | None,
        action: str,
        target_type: str | None = None,
        target_id: uuid.UUID | None = None,
        details: dict | None = None,
    ) -> None:
        """Секреты (пароли, приватные ключи, config_text) в details класть нельзя."""
        self.repo.add(
            AuditLog(
                actor_user_id=actor_user_id,
                actor_ip=actor_ip,
                action=action,
                target_type=target_type,
                target_id=target_id,
                details=details or {},
            )
        )

    async def list_all(
        self,
        actor_user_id: uuid.UUID | None = None,
        action: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> tuple[list[AuditLog], int]:
        return await self.repo.list_all(actor_user_id, action, date_from, date_to, page, page_size)
