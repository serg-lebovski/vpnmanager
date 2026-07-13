import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class UserCreateRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=1, max_length=128)
    password: str | None = None
    role: str = "USER"
    org_id: uuid.UUID | None = None


class UserUpdateRequest(BaseModel):
    full_name: str | None = None
    is_active: bool | None = None
    org_id: uuid.UUID | None = None


class UserResponse(BaseModel):
    id: uuid.UUID
    username: str
    full_name: str
    role: str
    org_id: uuid.UUID | None
    is_active: bool
    last_login_at: datetime | None
    created_at: datetime
    configs_count: int = 0

    model_config = {"from_attributes": True}


class ResetPasswordResponse(BaseModel):
    new_password: str
