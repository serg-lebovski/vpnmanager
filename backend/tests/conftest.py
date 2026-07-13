import os

os.environ.setdefault("ENCRYPTION_KEY", "IYFh6Tor_uUzWURqR5s2NoJ04bmgXxMFN7sMBAmnwsE=")
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest_asyncio  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.db.base import Base  # noqa: E402
from app.models import *  # noqa: E402,F401,F403 — регистрирует все модели в Base.metadata


@pytest_asyncio.fixture
async def db_session() -> "AsyncSession":
    """Async-сессия на sqlite в памяти со всеми таблицами — для сервисных юнит-тестов
    без Docker/Postgres. Интеграционные тесты на реальном Postgres — в tests/integration."""
    engine = create_async_engine(
        "sqlite+aiosqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session

    await engine.dispose()
