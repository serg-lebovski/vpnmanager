import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.core.passwords import generate_password, hash_password
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.users import UserRepository
from app.schemas.users import UserCreateRequest, UserUpdateRequest
from app.services.audit import AuditService


class UserService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = UserRepository(session)
        self.audit = AuditService(session)

    async def get_or_404(self, user_id: uuid.UUID) -> User:
        user = await self.repo.get_by_id(user_id)
        if not user:
            raise NotFoundError("User not found")
        return user

    async def list_all(
        self, org_id: uuid.UUID | None = None, query: str | None = None
    ) -> list[tuple[User, int]]:
        return await self.repo.list_all(org_id, query)

    async def create(
        self, data: UserCreateRequest, actor_id: uuid.UUID | None, actor_ip: str | None
    ) -> tuple[User, str]:
        if await self.repo.get_by_username(data.username):
            raise ConflictError("Username already exists")
        if data.role == UserRole.USER.value and data.org_id is None:
            raise ValidationError("USER must belong to an organization")
        if data.role in (UserRole.ADMIN.value, UserRole.ROOT.value) and data.org_id is not None:
            raise ValidationError("ADMIN/ROOT must not belong to an organization")

        password = data.password or generate_password()
        user = User(
            username=data.username,
            full_name=data.full_name,
            hashed_password=hash_password(password),
            role=data.role,
            org_id=data.org_id,
        )
        self.repo.add(user)
        await self.session.flush()
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="CREATE",
            target_type="USER", target_id=user.id, details={"username": user.username},
        )
        await self.session.commit()
        await self.session.refresh(user)
        return user, password

    async def update(self, user_id: uuid.UUID, data: UserUpdateRequest) -> User:
        user = await self.get_or_404(user_id)
        if data.full_name is not None:
            user.full_name = data.full_name
        if data.is_active is not None:
            user.is_active = data.is_active
        if data.org_id is not None:
            user.org_id = data.org_id
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def delete(
        self, user_id: uuid.UUID, actor_id: uuid.UUID | None, actor_ip: str | None
    ) -> None:
        user = await self.get_or_404(user_id)
        if user.role == UserRole.ROOT.value and await self.repo.count_by_role("ROOT") <= 1:
            raise ConflictError("Cannot delete the last ROOT user")
        await self.repo.delete(user)
        self.audit.log(
            actor_user_id=actor_id, actor_ip=actor_ip, action="DELETE",
            target_type="USER", target_id=user_id,
        )
        await self.session.commit()

    async def reset_password(self, user_id: uuid.UUID) -> str:
        user = await self.get_or_404(user_id)
        password = generate_password()
        user.hashed_password = hash_password(password)
        await self.session.commit()
        return password
