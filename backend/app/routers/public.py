import io
import uuid
from datetime import UTC, datetime

import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.crypto import decrypt
from app.core.rate_limit import RateLimitExceeded, check_rate_limit
from app.repositories.configs import ConfigRepository
from app.repositories.download_tokens import DownloadTokenRepository
from app.routers.deps import client_ip, get_db

router = APIRouter(prefix="/d", tags=["public-download"])


async def _resolve_valid_token(token: uuid.UUID, session: AsyncSession, request: Request):
    settings = get_settings()
    try:
        await check_rate_limit(f"ratelimit:download:{client_ip(request)}", settings.download_rate_limit)
    except RateLimitExceeded as exc:
        raise HTTPException(status_code=429, detail="Too many requests") from exc

    tokens_repo = DownloadTokenRepository(session)
    download_token = await tokens_repo.get_by_token(token)
    now = datetime.now(UTC)
    if (
        not download_token
        or download_token.used_at is not None
        or download_token.expires_at < now
    ):
        raise HTTPException(status_code=404, detail="Not found")

    config = await ConfigRepository(session).get_by_id(download_token.config_id)
    if not config:
        raise HTTPException(status_code=404, detail="Not found")
    return download_token, config


@router.get("/{token}")
async def download_config(
    token: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
) -> Response:
    download_token, config = await _resolve_valid_token(token, session, request)
    download_token.used_at = datetime.now(UTC)
    await session.commit()

    config_text = decrypt(config.config_text_encrypted)
    filename = f"{config.label}.conf".replace(" ", "_")
    return Response(
        content=config_text,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{token}/qr")
async def download_config_qr(
    token: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db)
) -> Response:
    _, config = await _resolve_valid_token(token, session, request)
    config_text = decrypt(config.config_text_encrypted)
    img = qrcode.make(config_text)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="image/png")
