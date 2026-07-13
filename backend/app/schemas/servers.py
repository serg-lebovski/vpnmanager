import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ServerCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    endpoint: str = Field(min_length=1, max_length=255)
    ssh_port: int = 22
    ssh_user: str = "root"
    ssh_private_key: str | None = None
    ssh_password: str | None = None
    wg_easy_password: str | None = None


class ServerUpdateRequest(BaseModel):
    name: str | None = None
    weight: int | None = None
    max_peers: int | None = None
    is_active: bool | None = None
    ssh_private_key: str | None = None
    ssh_password: str | None = None
    wg_easy_password: str | None = None


class ServerResponse(BaseModel):
    id: uuid.UUID
    name: str
    endpoint: str
    provider_type: str | None
    status: str
    ssh_host: str
    ssh_port: int
    ssh_user: str
    wg_interface: str | None
    wg_port: int | None
    server_public_key: str | None
    subnet: str | None
    weight: int
    max_peers: int | None
    is_active: bool
    offline_since: datetime | None
    last_checked_at: datetime | None
    detected_at: datetime | None
    detection_error: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ServerDetailResponse(ServerResponse):
    capabilities: dict


class ServerTestResponse(BaseModel):
    healthy: bool
    checked_at: datetime
