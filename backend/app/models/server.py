from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import CIDR, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.models.config import Config
    from app.models.organization import OrganizationServer


class Server(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "servers"

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(255), nullable=False)

    provider_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="PENDING")

    ssh_host: Mapped[str] = mapped_column(String(255), nullable=False)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22, nullable=False)
    ssh_user: Mapped[str] = mapped_column(String(64), nullable=False)
    ssh_credential_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    api_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)

    wg_interface: Mapped[str | None] = mapped_column(String(32), nullable=True)
    wg_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    server_public_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    # CIDR только на PostgreSQL (продакшен); на прочих диалектах (sqlite в тестах) — обычная строка.
    subnet: Mapped[str | None] = mapped_column(
        String(64).with_variant(CIDR(), "postgresql"), nullable=True
    )

    capabilities: Mapped[dict] = mapped_column(
        JSON().with_variant(JSONB(), "postgresql"), default=dict, nullable=False
    )
    detected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    detection_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    weight: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    max_peers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    offline_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    org_links: Mapped[list["OrganizationServer"]] = relationship(
        back_populates="server", cascade="all, delete-orphan"
    )
    configs: Mapped[list["Config"]] = relationship(back_populates="server")

    __table_args__ = ({"comment": "VPN-серверы"},)
