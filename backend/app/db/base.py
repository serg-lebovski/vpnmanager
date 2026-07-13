import uuid
from datetime import datetime

from sqlalchemy import DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class UUIDPKMixin:
    """id генерируется на стороне приложения (uuid.uuid4); server_default намеренно не
    используется, чтобы модели оставались переносимыми между диалектами (см. тесты на sqlite).
    В продакшене (PostgreSQL) DDL и default задаются миграцией Alembic."""

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
