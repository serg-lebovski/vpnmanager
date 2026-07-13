import uuid
from datetime import datetime

from pydantic import BaseModel


class AuditLogResponse(BaseModel):
    id: uuid.UUID
    actor_user_id: uuid.UUID | None
    actor_ip: str | None
    action: str
    target_type: str | None
    target_id: uuid.UUID | None
    details: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class AuditLogPage(BaseModel):
    items: list[AuditLogResponse]
    total: int
    page: int
    page_size: int


class DashboardResponse(BaseModel):
    servers_online: int
    servers_total: int
    users_total: int
    configs_total: int
    configs_last_24h: int
    servers: list[dict]
    configs_per_server: dict[str, int]
    problems: dict[str, list[dict]]
