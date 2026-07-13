import io
import uuid
import zipfile

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.repositories.configs import ConfigRepository
from app.repositories.organizations import OrganizationRepository
from app.routers.deps import client_ip, get_db, require_admin
from app.schemas.organizations import (
    OrganizationCreateRequest,
    OrganizationResponse,
    OrganizationServersUpdateRequest,
    OrganizationStatsResponse,
    OrganizationUpdateRequest,
)
from app.services.configs import ConfigService
from app.services.organizations import OrganizationService

router = APIRouter(prefix="/api/orgs", tags=["organizations"])


@router.get("")
async def list_orgs(
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db)
) -> list[OrganizationResponse]:
    orgs = await OrganizationService(session).list_all()
    return [OrganizationResponse.model_validate(o) for o in orgs]


@router.post("")
async def create_org(
    request: Request,
    data: OrganizationCreateRequest,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    org = await OrganizationService(session).create(data, current_user.id, client_ip(request))
    return OrganizationResponse.model_validate(org)


@router.get("/{org_id}")
async def get_org(
    org_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    org = await OrganizationService(session).get_or_404(org_id)
    return OrganizationResponse.model_validate(org)


@router.patch("/{org_id}")
async def update_org(
    org_id: uuid.UUID,
    data: OrganizationUpdateRequest,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> OrganizationResponse:
    org = await OrganizationService(session).update(org_id, data)
    return OrganizationResponse.model_validate(org)


@router.delete("/{org_id}")
async def delete_org(
    org_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await OrganizationService(session).delete(org_id)
    return {"ok": True}


@router.put("/{org_id}/servers")
async def set_org_servers(
    org_id: uuid.UUID,
    data: OrganizationServersUpdateRequest,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await OrganizationService(session).set_servers(org_id, data.server_ids)
    return {"ok": True}


@router.get("/{org_id}/stats")
async def org_stats(
    org_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> OrganizationStatsResponse:
    stats = await OrganizationService(session).stats(org_id)
    return OrganizationStatsResponse(**stats)


@router.get("/{org_id}/export")
async def export_org(
    org_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    org = await OrganizationService(session).get_or_404(org_id)
    server_ids = await OrganizationRepository(session).list_server_ids(org_id)
    config_service = ConfigService(session)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for server_id in server_ids:
            configs = await ConfigRepository(session).list_all(server_id=server_id, include_revoked=False)
            for config in configs:
                config_text = config_service.decrypt_config_text(config)
                filename = f"{config.label}_{config.vpn_ip}.conf".replace(" ", "_")
                zf.writestr(filename, config_text)
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{org.name}_configs.zip"'},
    )
