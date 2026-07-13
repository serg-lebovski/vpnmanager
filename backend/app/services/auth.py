import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.exceptions import AuthError
from app.core.passwords import generate_password, hash_password, verify_password
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.users import UserRepository
from app.services.audit import AuditService


class AuthService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.users = UserRepository(session)
        self.audit = AuditService(session)

    async def authenticate(self, username: str, password: str, actor_ip: str | None) -> User:
        user = await self.users.get_by_username(username)
        if not user or not user.is_active or not verify_password(password, user.hashed_password):
            self.audit.log(
                actor_user_id=user.id if user else None,
                actor_ip=actor_ip,
                action="LOGIN_FAILED",
                target_type="USER",
                target_id=user.id if user else None,
                details={"username": username},
            )
            raise AuthError("Invalid username or password", code="INVALID_CREDENTIALS")

        user.last_login_at = datetime.now(UTC)
        self.audit.log(
            actor_user_id=user.id,
            actor_ip=actor_ip,
            action="LOGIN",
            target_type="USER",
            target_id=user.id,
        )
        await self.session.commit()
        return user

    def log_logout(self, user_id: uuid.UUID, actor_ip: str | None) -> None:
        self.audit.log(
            actor_user_id=user_id, actor_ip=actor_ip, action="LOGOUT", target_type="USER",
            target_id=user_id,
        )

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        return await self.users.get_by_id(user_id)


async def bootstrap_root(session: AsyncSession) -> None:
    """Создаёт ROOT-пользователя при первом старте и пишет admin_credentials.txt (раздел 3)."""
    users = UserRepository(session)
    if await users.count_by_role(UserRole.ROOT.value) > 0:
        return

    settings = get_settings()
    password = generate_password()
    root = User(
        username="root",
        full_name="Root Administrator",
        hashed_password=hash_password(password),
        role=UserRole.ROOT.value,
        org_id=None,
    )
    users.add(root)
    await session.commit()

    creds_path = Path(settings.data_dir) / "admin_credentials.txt"
    if creds_path.exists():
        return

    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    content = (
        f"# Amnezia VPN Manager — сгенерировано {now}\n"
        f"URL:      https://{settings.host}/login\n"
        f"Username: root\n"
        f"Password: {password}\n"
    )
    creds_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(creds_path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(content)

    print(content)  # noqa: T201 — единожды в stdout контейнера, по требованию ТЗ
