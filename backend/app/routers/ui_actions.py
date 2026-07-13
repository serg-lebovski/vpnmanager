import uuid

from fastapi import APIRouter, Depends, Form, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.exceptions import AppError
from app.core.rate_limit import RateLimitExceeded, check_rate_limit
from app.core.sessions import (
    CSRF_COOKIE_NAME,
    SESSION_COOKIE_NAME,
    create_session_token,
    generate_csrf_token,
    session_expiry,
)
from app.models.user import User
from app.repositories.organizations import OrganizationRepository
from app.routers.deps import client_ip, get_current_user, get_db, require_admin, require_any
from app.schemas.configs import ConfigCreateRequest
from app.schemas.organizations import OrganizationCreateRequest
from app.schemas.servers import ServerCreateRequest
from app.schemas.users import UserCreateRequest
from app.services.auth import AuthService
from app.services.configs import ConfigService
from app.services.organizations import OrganizationService
from app.services.servers import ServerService
from app.services.users import UserService
from app.templating import templates

router = APIRouter(tags=["ui-actions"])


@router.post("/login")
async def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    session: AsyncSession = Depends(get_db),
) -> Response:
    ip = client_ip(request)
    settings = get_settings()
    try:
        try:
            await check_rate_limit(f"ratelimit:login:{ip}", settings.login_rate_limit)
        except RateLimitExceeded:
            error = "Слишком много попыток входа, повторите позже"
            return templates.TemplateResponse(
                request, "login.html", {"error": error, "csrf_token": _csrf(request)}, status_code=429
            )
        user = await AuthService(session).authenticate(username, password, ip)
    except AppError:
        return templates.TemplateResponse(
            request, "login.html",
            {"error": "Неверный логин или пароль", "csrf_token": _csrf(request)},
            status_code=401,
        )

    response = RedirectResponse("/", status_code=303)
    token = create_session_token(user.id)
    expiry = session_expiry()
    response.set_cookie(SESSION_COOKIE_NAME, token, httponly=True, secure=True, samesite="lax", expires=expiry)
    response.set_cookie(CSRF_COOKIE_NAME, generate_csrf_token(), httponly=False, secure=True, samesite="lax", expires=expiry)
    return response


@router.post("/logout")
async def logout_submit(
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> Response:
    AuthService(session).log_logout(current_user.id, client_ip(request))
    await session.commit()
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE_NAME)
    response.delete_cookie(CSRF_COOKIE_NAME)
    return response


def _csrf(request: Request) -> str:
    return request.cookies.get(CSRF_COOKIE_NAME, "")


@router.post("/servers/add")
async def add_server(
    request: Request,
    name: str = Form(...),
    endpoint: str = Form(...),
    ssh_port: int = Form(22),
    ssh_user: str = Form("root"),
    ssh_private_key: str = Form(""),
    ssh_password: str = Form(""),
    wg_easy_password: str = Form(""),
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> Response:
    data = ServerCreateRequest(
        name=name, endpoint=endpoint, ssh_port=ssh_port, ssh_user=ssh_user,
        ssh_private_key=ssh_private_key or None, ssh_password=ssh_password or None,
        wg_easy_password=wg_easy_password or None,
    )
    await ServerService(session).create(data, current_user.id, client_ip(request))
    servers = await ServerService(session).list_all()
    return templates.TemplateResponse(
        request, "servers/_table.html", {"servers": servers, "csrf_token": _csrf(request)}
    )


@router.post("/servers/{server_id}/detect")
async def detect_server(
    server_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await ServerService(session).redetect(server_id, current_user.id, client_ip(request))
    servers = await ServerService(session).list_all()
    return templates.TemplateResponse(request, "servers/_table.html", {"servers": servers, "csrf_token": _csrf(request)})


@router.post("/servers/{server_id}/test")
async def test_server(
    server_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await ServerService(session).test(server_id)
    servers = await ServerService(session).list_all()
    return templates.TemplateResponse(request, "servers/_table.html", {"servers": servers, "csrf_token": _csrf(request)})


@router.delete("/servers/{server_id}")
async def delete_server(
    server_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await ServerService(session).delete(server_id, current_user.id, client_ip(request))
    servers = await ServerService(session).list_all()
    return templates.TemplateResponse(request, "servers/_table.html", {"servers": servers, "csrf_token": _csrf(request)})


@router.post("/organizations/add")
async def add_org(
    request: Request,
    name: str = Form(...),
    auto_cleanup_days: str = Form(""),
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> Response:
    data = OrganizationCreateRequest(
        name=name, auto_cleanup_days=int(auto_cleanup_days) if auto_cleanup_days else None
    )
    await OrganizationService(session).create(data, current_user.id, client_ip(request))
    return await _render_orgs_table(request, session)


@router.put("/organizations/{org_id}/servers")
async def set_org_servers(
    org_id: uuid.UUID, request: Request,
    server_ids: list[uuid.UUID] = Form(default=[]),
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await OrganizationService(session).set_servers(
        org_id, server_ids, current_user.id, client_ip(request)
    )
    return await _render_orgs_table(request, session)


@router.delete("/organizations/{org_id}")
async def delete_org(
    org_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await OrganizationService(session).delete(org_id, current_user.id, client_ip(request))
    return await _render_orgs_table(request, session)


async def _render_orgs_table(request: Request, session: AsyncSession) -> Response:
    orgs = await OrganizationService(session).list_all()
    all_servers = await ServerService(session).list_all()
    org_repo = OrganizationRepository(session)
    orgs_view = []
    for org in orgs:
        server_ids = set(await org_repo.list_server_ids(org.id))
        orgs_view.append({"id": org.id, "name": org.name, "auto_cleanup_days": org.auto_cleanup_days, "server_ids": server_ids})
    return templates.TemplateResponse(
        request, "organizations/_table.html",
        {"orgs": orgs_view, "all_servers": all_servers, "csrf_token": _csrf(request)},
    )


@router.post("/users/add")
async def add_user(
    request: Request,
    username: str = Form(...),
    full_name: str = Form(...),
    role: str = Form("USER"),
    org_id: str = Form(""),
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> Response:
    data = UserCreateRequest(
        username=username, full_name=full_name, role=role,
        org_id=uuid.UUID(org_id) if org_id else None,
    )
    await UserService(session).create(data, current_user.id, client_ip(request))
    return await _render_users_table(request, session)


@router.post("/users/{user_id}/reset-password")
async def reset_password(
    user_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await UserService(session).reset_password(user_id, current_user.id, client_ip(request))
    return await _render_users_table(request, session)


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db),
) -> Response:
    await UserService(session).delete(user_id, current_user.id, client_ip(request))
    return await _render_users_table(request, session)


async def _render_users_table(request: Request, session: AsyncSession) -> Response:
    rows = await UserService(session).list_all()
    org_repo = OrganizationRepository(session)
    orgs = await org_repo.list_all()
    org_by_id = {o.id: o.name for o in orgs}
    users_view = []
    for user, count in rows:
        user.configs_count = count  # type: ignore[attr-defined]
        users_view.append((user, org_by_id.get(user.org_id) if user.org_id else None))
    return templates.TemplateResponse(
        request, "users/_table.html", {"users": users_view, "csrf_token": _csrf(request)}
    )


@router.post("/my-configs/add")
async def add_my_config(
    request: Request,
    device_type: str = Form(...),
    label: str = Form(...),
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> Response:
    data = ConfigCreateRequest(device_type=device_type, label=label)
    await ConfigService(session).create(data, current_user, client_ip(request))
    return await _render_configs_list(request, current_user, session)


@router.delete("/my-configs/{config_id}")
async def delete_my_config(
    config_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_any), session: AsyncSession = Depends(get_db),
) -> Response:
    await ConfigService(session).delete(config_id, current_user, client_ip(request))
    return await _render_configs_list(request, current_user, session)


@router.post("/my-configs/{config_id}/recreate")
async def recreate_my_config(
    config_id: uuid.UUID, request: Request,
    current_user: User = Depends(require_any), session: AsyncSession = Depends(get_db),
) -> Response:
    await ConfigService(session).recreate(config_id, current_user, client_ip(request))
    return await _render_configs_list(request, current_user, session)


@router.get("/my-configs/{config_id}/download")
async def download_my_config(
    config_id: uuid.UUID,
    current_user: User = Depends(require_any), session: AsyncSession = Depends(get_db),
) -> Response:
    token = await ConfigService(session).create_download_link(config_id, current_user)
    return RedirectResponse(f"/d/{token.token}", status_code=303)


async def _render_configs_list(request: Request, current_user: User, session: AsyncSession) -> Response:
    configs = await ConfigService(session).list_all(current_user, None, None, None)
    return templates.TemplateResponse(
        request, "configs/_list.html", {"configs": configs, "csrf_token": _csrf(request)}
    )
