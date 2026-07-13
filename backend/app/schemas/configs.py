import uuid
from datetime import datetime

from pydantic import BaseModel


class ConfigCreateRequest(BaseModel):
    device_type: str
    label: str
    user_id: uuid.UUID | None = None


class ConfigResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    server_id: uuid.UUID
    device_type: str
    label: str
    vpn_ip: str
    public_key: str
    last_handshake: datetime | None
    rx_bytes: int
    tx_bytes: int
    is_revoked: bool
    needs_recreate: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ConfigCreatedResponse(ConfigResponse):
    config_text: str


class DownloadLinkResponse(BaseModel):
    url: str
    expires_at: datetime
