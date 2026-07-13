import pytest

from app.services.audit import AuditService


@pytest.mark.asyncio
async def test_log_and_list(db_session):
    service = AuditService(db_session)
    service.log(actor_user_id=None, actor_ip="1.2.3.4", action="LOGIN")
    await db_session.commit()

    logs, total = await service.list_all()
    assert total == 1
    assert logs[0].action == "LOGIN"
    assert logs[0].actor_ip == "1.2.3.4"


@pytest.mark.asyncio
async def test_list_filters_by_action(db_session):
    service = AuditService(db_session)
    service.log(actor_user_id=None, actor_ip=None, action="LOGIN")
    service.log(actor_user_id=None, actor_ip=None, action="LOGIN_FAILED")
    await db_session.commit()

    logs, total = await service.list_all(action="LOGIN_FAILED")
    assert total == 1
    assert logs[0].action == "LOGIN_FAILED"
