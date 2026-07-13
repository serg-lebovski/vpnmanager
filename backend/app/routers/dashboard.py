import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.config import Config
from app.models.server import Server
from app.models.user import User
from app.routers.deps import get_db, require_admin
from app.schemas.audit import AuditLogPage, AuditLogResponse, DashboardResponse
from app.services.audit import AuditService

router = APIRouter(tags=["dashboard"])


@router.get("/api/dashboard")
async def dashboard(
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db)
) -> DashboardResponse:
    servers = list((await session.execute(select(Server))).scalars().all())
    servers_online = len([s for s in servers if s.status == "ONLINE"])

    users_total = int(
        (await session.execute(select(func.count()).select_from(User))).scalar_one()
    )
    configs_total = int(
        (await session.execute(select(func.count()).select_from(Config))).scalar_one()
    )
    since = datetime.now(UTC) - timedelta(hours=24)
    configs_last_24h = int(
        (
            await session.execute(
                select(func.count()).select_from(Config).where(Config.created_at >= since)
            )
        ).scalar_one()
    )

    configs_per_server: dict[str, int] = {}
    for server in servers:
        count = int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(Config)
                    .where(Config.server_id == server.id, Config.is_revoked.is_(False))
                )
            ).scalar_one()
        )
        configs_per_server[server.name] = count

    problem_servers = [
        {"id": str(s.id), "name": s.name, "status": s.status, "detection_error": s.detection_error}
        for s in servers
        if s.status in ("UNSUPPORTED", "UNREACHABLE")
    ]
    needs_recreate = list(
        (
            await session.execute(select(Config).where(Config.needs_recreate.is_(True)))
        ).scalars().all()
    )

    return DashboardResponse(
        servers_online=servers_online,
        servers_total=len(servers),
        users_total=users_total,
        configs_total=configs_total,
        configs_last_24h=configs_last_24h,
        servers=[
            {
                "id": str(s.id),
                "name": s.name,
                "endpoint": s.endpoint,
                "provider_type": s.provider_type,
                "status": s.status,
                "weight": s.weight,
                "last_checked_at": s.last_checked_at.isoformat() if s.last_checked_at else None,
                "active_configs": configs_per_server.get(s.name, 0),
            }
            for s in servers
        ],
        configs_per_server=configs_per_server,
        problems={
            "servers": problem_servers,
            "configs_needing_recreate": [
                {"id": str(c.id), "label": c.label, "user_id": str(c.user_id)}
                for c in needs_recreate
            ],
        },
    )


@router.get("/api/audit")
async def audit_log(
    actor: str | None = None,
    action: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = 1,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> AuditLogPage:
    actor_id = uuid.UUID(actor) if actor else None
    items, total = await AuditService(session).list_all(actor_id, action, date_from, date_to, page)
    return AuditLogPage(
        items=[AuditLogResponse.model_validate(i) for i in items],
        total=total,
        page=page,
        page_size=50,
    )
