import ipaddress
import uuid
from datetime import UTC, datetime

from app.models.audit_log import AuditLog
from app.schemas.audit import AuditLogResponse


def test_actor_ip_accepts_ipaddress_object_from_asyncpg():
    """asyncpg возвращает ipaddress.IPv4Address для колонки INET — схема должна
    приводить его к строке, а не падать с ValidationError (регрессия по деплою)."""
    log = AuditLog(
        id=uuid.uuid4(),
        actor_user_id=None,
        actor_ip=ipaddress.IPv4Address("2.58.98.242"),
        action="LOGIN",
        target_type=None,
        target_id=None,
        details={},
        created_at=datetime.now(UTC),
    )
    response = AuditLogResponse.model_validate(log)
    assert response.actor_ip == "2.58.98.242"


def test_actor_ip_none_stays_none():
    log = AuditLog(
        id=uuid.uuid4(), actor_user_id=None, actor_ip=None, action="LOGIN",
        target_type=None, target_id=None, details={}, created_at=datetime.now(UTC),
    )
    response = AuditLogResponse.model_validate(log)
    assert response.actor_ip is None
