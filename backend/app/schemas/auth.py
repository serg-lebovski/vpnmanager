import uuid

from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str
    password: str


class MeResponse(BaseModel):
    id: uuid.UUID
    username: str
    full_name: str
    role: str
    org_id: uuid.UUID | None
