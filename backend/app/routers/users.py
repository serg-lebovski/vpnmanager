import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.routers.deps import client_ip, get_db, require_admin
from app.schemas.users import (
    ResetPasswordResponse,
    UserCreateRequest,
    UserResponse,
    UserUpdateRequest,
)
from app.services.users import UserService

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("")
async def list_users(
    org_id: uuid.UUID | None = None,
    q: str | None = None,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> list[UserResponse]:
    rows = await UserService(session).list_all(org_id, q)
    return [
        UserResponse.model_validate(user).model_copy(update={"configs_count": count})
        for user, count in rows
    ]


@router.post("")
async def create_user(
    request: Request,
    data: UserCreateRequest,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> dict:
    user, password = await UserService(session).create(data, current_user.id, client_ip(request))
    payload = UserResponse.model_validate(user).model_dump(mode="json")
    payload["generated_password"] = password if not data.password else None
    return payload


@router.patch("/{user_id}")
async def update_user(
    user_id: uuid.UUID,
    data: UserUpdateRequest,
    request: Request,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> UserResponse:
    user = await UserService(session).update(user_id, data, current_user.id, client_ip(request))
    return UserResponse.model_validate(user)


@router.delete("/{user_id}")
async def delete_user(
    user_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await UserService(session).delete(user_id, current_user.id, client_ip(request))
    return {"ok": True}


@router.post("/{user_id}/reset-password")
async def reset_password(
    user_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> ResetPasswordResponse:
    password = await UserService(session).reset_password(user_id, current_user.id, client_ip(request))
    return ResetPasswordResponse(new_password=password)
