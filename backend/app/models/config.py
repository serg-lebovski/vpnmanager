import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.models.download_token import DownloadToken
    from app.models.server import Server
    from app.models.user import User


class Config(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "configs"
    __table_args__ = (UniqueConstraint("server_id", "vpn_ip", name="uq_server_vpn_ip"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    server_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("servers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    peer_id: Mapped[str] = mapped_column(String(255), nullable=False)
    device_type: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)

    private_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    preshared_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    vpn_ip: Mapped[str] = mapped_column(String(64), nullable=False)
    config_text_encrypted: Mapped[str] = mapped_column(Text, nullable=False)

    last_handshake: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rx_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    tx_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    needs_recreate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped["User"] = relationship(back_populates="configs")
    server: Mapped["Server"] = relationship(back_populates="configs")
    download_tokens: Mapped[list["DownloadToken"]] = relationship(
        back_populates="config", cascade="all, delete-orphan"
    )
