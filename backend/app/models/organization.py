import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.models.server import Server
    from app.models.user import User


class Organization(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    auto_cleanup_days: Mapped[int | None] = mapped_column(Integer, nullable=True)

    server_links: Mapped[list["OrganizationServer"]] = relationship(
        back_populates="organization", cascade="all, delete-orphan"
    )
    users: Mapped[list["User"]] = relationship(back_populates="organization")


class OrganizationServer(UUIDPKMixin, Base):
    __tablename__ = "organization_servers"
    __table_args__ = (UniqueConstraint("org_id", "server_id", name="uq_org_server"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    server_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("servers.id", ondelete="CASCADE"), nullable=False
    )

    organization: Mapped["Organization"] = relationship(back_populates="server_links")
    server: Mapped["Server"] = relationship(back_populates="org_links")
