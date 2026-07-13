"""Интеграционный тест: реальный PostgreSQL через testcontainers + Alembic-миграции.

Требует Docker. Пропускается автоматически, если Docker недоступен (например, в CI
без docker-in-docker или в этой сессии разработки без установленного Docker).
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(shutil.which("docker") is None, reason="Docker недоступен")

BACKEND_DIR = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_alembic_upgrade_head_creates_all_tables():
    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:15-alpine") as postgres:
        db_url = postgres.get_connection_url().replace("psycopg2", "asyncpg")

        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=BACKEND_DIR,
            env={"DATABASE_URL": db_url, "ENCRYPTION_KEY": "x" * 32, "SESSION_SECRET": "x",
                 "PATH": __import__("os").environ.get("PATH", "")},
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr

        from sqlalchemy import inspect
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
        await engine.dispose()

        expected = {
            "organizations", "servers", "users", "organization_servers",
            "configs", "download_tokens", "audit_logs", "alembic_version",
        }
        assert expected.issubset(set(tables))
