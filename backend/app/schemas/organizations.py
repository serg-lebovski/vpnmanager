import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class OrganizationCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    auto_cleanup_days: int | None = None


class OrganizationUpdateRequest(BaseModel):
    name: str | None = None
    auto_cleanup_days: int | None = None


class OrganizationResponse(BaseModel):
    id: uuid.UUID
    name: str
    auto_cleanup_days: int | None
    created_at: datetime

    model_config = {"from_attributes": True}


class OrganizationServersUpdateRequest(BaseModel):
    server_ids: list[uuid.UUID]


class OrganizationStatsResponse(BaseModel):
    servers_count: int
    users_count: int
    configs_count: int
    configs_active: int
