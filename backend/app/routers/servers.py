import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.providers.base import NotSupportedError
from app.routers.deps import client_ip, get_db, require_admin
from app.schemas.servers import (
    ServerCreateRequest,
    ServerDetailResponse,
    ServerResponse,
    ServerTestResponse,
    ServerUpdateRequest,
)
from app.services.servers import ServerService

router = APIRouter(prefix="/api/servers", tags=["servers"])


@router.get("")
async def list_servers(
    current_user: User = Depends(require_admin), session: AsyncSession = Depends(get_db)
) -> list[ServerResponse]:
    servers = await ServerService(session).list_all()
    return [ServerResponse.model_validate(s) for s in servers]


@router.post("")
async def create_server(
    request: Request,
    data: ServerCreateRequest,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> ServerDetailResponse:
    server = await ServerService(session).create(data, current_user.id, client_ip(request))
    return ServerDetailResponse.model_validate(server)


@router.get("/{server_id}")
async def get_server(
    server_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> ServerDetailResponse:
    server = await ServerService(session).get_or_404(server_id)
    return ServerDetailResponse.model_validate(server)


@router.patch("/{server_id}")
async def update_server(
    server_id: uuid.UUID,
    data: ServerUpdateRequest,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> ServerDetailResponse:
    server = await ServerService(session).update(server_id, data)
    return ServerDetailResponse.model_validate(server)


@router.post("/{server_id}/detect")
async def redetect_server(
    server_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> ServerDetailResponse:
    server = await ServerService(session).redetect(server_id, current_user.id, client_ip(request))
    return ServerDetailResponse.model_validate(server)


@router.post("/{server_id}/test")
async def test_server(
    server_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> ServerTestResponse:
    healthy = await ServerService(session).test(server_id)
    return ServerTestResponse(healthy=healthy, checked_at=datetime.now(UTC))


@router.delete("/{server_id}")
async def delete_server(
    server_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await ServerService(session).delete(server_id)
    return {"ok": True}


@router.post("/{server_id}/rotate-keys")
async def rotate_keys(
    server_id: uuid.UUID,
    current_user: User = Depends(require_admin),
    session: AsyncSession = Depends(get_db),
) -> dict:
    try:
        await ServerService(session).rotate_keys(server_id)
    except NotSupportedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    return {"ok": True}
