import io
import uuid

import qrcode
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.routers.deps import client_ip, get_db, require_any
from app.schemas.configs import (
    ConfigCreatedResponse,
    ConfigCreateRequest,
    ConfigResponse,
    DownloadLinkResponse,
)
from app.services.configs import ConfigService

router = APIRouter(prefix="/api/configs", tags=["configs"])


@router.get("")
async def list_configs(
    user_id: uuid.UUID | None = None,
    org_id: uuid.UUID | None = None,
    server_id: uuid.UUID | None = None,
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> list[ConfigResponse]:
    configs = await ConfigService(session).list_all(current_user, user_id, org_id, server_id)
    return [ConfigResponse.model_validate(c) for c in configs]


@router.post("")
async def create_config(
    request: Request,
    data: ConfigCreateRequest,
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> ConfigCreatedResponse:
    config, config_text = await ConfigService(session).create(data, current_user, client_ip(request))
    payload = ConfigResponse.model_validate(config).model_dump()
    return ConfigCreatedResponse(**payload, config_text=config_text)


@router.delete("/{config_id}")
async def delete_config(
    config_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await ConfigService(session).delete(config_id, current_user, client_ip(request))
    return {"ok": True}


@router.post("/{config_id}/download-link")
async def create_download_link(
    config_id: uuid.UUID,
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> DownloadLinkResponse:
    token = await ConfigService(session).create_download_link(config_id, current_user)
    return DownloadLinkResponse(url=f"/d/{token.token}", expires_at=token.expires_at)


@router.post("/{config_id}/recreate")
async def recreate_config(
    config_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> ConfigResponse:
    config = await ConfigService(session).recreate(config_id, current_user, client_ip(request))
    return ConfigResponse.model_validate(config)


@router.get("/{config_id}/qr")
async def config_qr(
    config_id: uuid.UUID,
    current_user: User = Depends(require_any),
    session: AsyncSession = Depends(get_db),
) -> Response:
    service = ConfigService(session)
    config = await service.get_or_404(config_id)
    service.assert_visible(config, current_user)
    config_text = service.decrypt_config_text(config)
    img = qrcode.make(config_text)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="image/png")
