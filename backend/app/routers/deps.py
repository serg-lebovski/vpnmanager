from collections.abc import AsyncGenerator, Callable

from fastapi import Cookie, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.sessions import SESSION_COOKIE_NAME, read_session_token
from app.db.session import async_session_factory
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.users import UserRepository


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def get_current_user(
    session: AsyncSession = Depends(get_db),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> User:
    if not session_cookie:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = read_session_token(session_cookie)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = await UserRepository(session).get_by_id(user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid session")
    return user


async def get_current_user_optional(
    session: AsyncSession = Depends(get_db),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> User | None:
    if not session_cookie:
        return None
    user_id = read_session_token(session_cookie)
    if not user_id:
        return None
    user = await UserRepository(session).get_by_id(user_id)
    if not user or not user.is_active:
        return None
    return user


def require_roles(*roles: UserRole) -> Callable:
    async def checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in {r.value for r in roles}:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user

    return checker


require_admin = require_roles(UserRole.ROOT, UserRole.ADMIN)
require_any = require_roles(UserRole.ROOT, UserRole.ADMIN, UserRole.USER)
