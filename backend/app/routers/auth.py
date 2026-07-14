from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.exceptions import RateLimitedError
from app.core.rate_limit import RateLimitExceeded, check_rate_limit
from app.core.sessions import (
    CSRF_COOKIE_NAME,
    SESSION_COOKIE_NAME,
    create_session_token,
    generate_csrf_token,
    session_expiry,
)
from app.models.user import User
from app.routers.deps import client_ip, get_current_user, get_db
from app.schemas.auth import LoginRequest, MeResponse
from app.services.auth import AuthService

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
async def login(
    request: Request,
    response: Response,
    data: LoginRequest,
    session: AsyncSession = Depends(get_db),
) -> MeResponse:
    ip = client_ip(request)
    settings = get_settings()
    try:
        await check_rate_limit(f"ratelimit:login:{ip}", settings.login_rate_limit)
    except RateLimitExceeded as exc:
        raise RateLimitedError("Слишком много попыток входа, повторите позже") from exc

    user = await AuthService(session).authenticate(data.username, data.password, ip)

    token = create_session_token(user.id)
    expiry = session_expiry()
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        secure=True,
        samesite="lax",
        expires=expiry,
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        generate_csrf_token(),
        httponly=False,
        secure=True,
        samesite="lax",
        expires=expiry,
    )
    return MeResponse(
        id=user.id, username=user.username, full_name=user.full_name,
        role=user.role, org_id=user.org_id,
    )


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    AuthService(session).log_logout(current_user.id, client_ip(request))
    await session.commit()
    response.delete_cookie(SESSION_COOKIE_NAME)
    response.delete_cookie(CSRF_COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
async def me(current_user: User = Depends(get_current_user)) -> MeResponse:
    return MeResponse(
        id=current_user.id, username=current_user.username, full_name=current_user.full_name,
        role=current_user.role, org_id=current_user.org_id,
    )
