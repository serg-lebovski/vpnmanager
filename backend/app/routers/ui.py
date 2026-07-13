from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.sessions import CSRF_COOKIE_NAME, generate_csrf_token
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.organizations import OrganizationRepository
from app.routers.deps import get_current_user_optional, get_db
from app.services.organizations import OrganizationService
from app.services.servers import ServerService
from app.services.users import UserService
from app.templating import templates

router = APIRouter(tags=["ui-pages"])


def _csrf(request: Request) -> str:
    return request.cookies.get(CSRF_COOKIE_NAME, "")


@router.get("/login")
async def login_page(request: Request, current_user: User | None = Depends(get_current_user_optional)):
    if current_user:
        return RedirectResponse("/", status_code=303)
    token = generate_csrf_token()
    response = templates.TemplateResponse(request, "login.html", {"csrf_token": token})
    response.set_cookie(CSRF_COOKIE_NAME, token, httponly=False, secure=True, samesite="lax")
    return response


def _require_page_user(current_user: User | None) -> User | RedirectResponse:
    if not current_user:
        return RedirectResponse("/login", status_code=303)
    return current_user


def _require_admin_page(current_user: User | None) -> User | RedirectResponse:
    guard = _require_page_user(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    if guard.role == UserRole.USER.value:
        return RedirectResponse("/my-configs", status_code=303)
    return guard


@router.get("/")
async def dashboard_page(
    request: Request,
    current_user: User | None = Depends(get_current_user_optional),
    session: AsyncSession = Depends(get_db),
):
    guard = _require_page_user(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    current_user = guard
    if current_user.role == UserRole.USER.value:
        return RedirectResponse("/my-configs", status_code=303)

    from app.routers.dashboard import dashboard as dashboard_api

    data = await dashboard_api(current_user, session)
    return templates.TemplateResponse(
        request, "dashboard.html",
        {"current_user": current_user, "csrf_token": _csrf(request), "data": data},
    )


@router.get("/servers")
async def servers_page(
    request: Request,
    current_user: User | None = Depends(get_current_user_optional),
    session: AsyncSession = Depends(get_db),
):
    guard = _require_admin_page(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    servers = await ServerService(session).list_all()
    return templates.TemplateResponse(
        request, "servers/list.html",
        {"current_user": current_user, "csrf_token": _csrf(request), "servers": servers},
    )


@router.get("/organizations")
async def organizations_page(
    request: Request,
    current_user: User | None = Depends(get_current_user_optional),
    session: AsyncSession = Depends(get_db),
):
    guard = _require_admin_page(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    org_service = OrganizationService(session)
    orgs = await org_service.list_all()
    all_servers = await ServerService(session).list_all()
    org_repo = OrganizationRepository(session)
    orgs_view = []
    for org in orgs:
        server_ids = set(await org_repo.list_server_ids(org.id))
        orgs_view.append({"id": org.id, "name": org.name, "auto_cleanup_days": org.auto_cleanup_days, "server_ids": server_ids})
    return templates.TemplateResponse(
        request, "organizations/list.html",
        {
            "current_user": current_user, "csrf_token": _csrf(request),
            "orgs": orgs_view, "all_servers": all_servers,
        },
    )


@router.get("/users")
async def users_page(
    request: Request,
    current_user: User | None = Depends(get_current_user_optional),
    session: AsyncSession = Depends(get_db),
):
    guard = _require_admin_page(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    rows = await UserService(session).list_all()
    org_repo = OrganizationRepository(session)
    orgs = await org_repo.list_all()
    org_by_id = {o.id: o.name for o in orgs}
    users_view = []
    for user, count in rows:
        user.configs_count = count  # type: ignore[attr-defined]
        users_view.append((user, org_by_id.get(user.org_id) if user.org_id else None))
    return templates.TemplateResponse(
        request, "users/list.html",
        {"current_user": current_user, "csrf_token": _csrf(request), "users": users_view, "orgs": orgs},
    )


@router.get("/my-configs")
async def my_configs_page(
    request: Request,
    current_user: User | None = Depends(get_current_user_optional),
    session: AsyncSession = Depends(get_db),
):
    guard = _require_page_user(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    current_user = guard
    from app.services.configs import ConfigService

    configs = await ConfigService(session).list_all(current_user, None, None, None)
    return templates.TemplateResponse(
        request, "configs/my.html",
        {"current_user": current_user, "csrf_token": _csrf(request), "configs": configs},
    )


@router.get("/audit")
async def audit_page(
    request: Request,
    page: int = 1,
    current_user: User | None = Depends(get_current_user_optional),
    session: AsyncSession = Depends(get_db),
):
    guard = _require_admin_page(current_user)
    if isinstance(guard, RedirectResponse):
        return guard
    from app.services.audit import AuditService

    logs, total = await AuditService(session).list_all(page=page)
    return templates.TemplateResponse(
        request, "audit/list.html",
        {"current_user": current_user, "csrf_token": _csrf(request), "logs": logs, "total": total, "page": page},
    )
