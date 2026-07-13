import pytest

from app.core.exceptions import ConflictError, ValidationError
from app.models.organization import Organization
from app.schemas.users import UserCreateRequest
from app.services.audit import AuditService
from app.services.users import UserService


async def make_org(db_session) -> Organization:
    org = Organization(name="Acme")
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    return org


@pytest.mark.asyncio
async def test_create_user_requires_org_for_role_user(db_session):
    service = UserService(db_session)
    with pytest.raises(ValidationError):
        await service.create(
            UserCreateRequest(username="ivan", full_name="Ivan Ivanov", role="USER", org_id=None),
            actor_id=None,
            actor_ip=None,
        )


@pytest.mark.asyncio
async def test_create_admin_must_not_have_org(db_session):
    org = await make_org(db_session)
    service = UserService(db_session)
    with pytest.raises(ValidationError):
        await service.create(
            UserCreateRequest(username="admin1", full_name="Admin One", role="ADMIN", org_id=org.id),
            actor_id=None,
            actor_ip=None,
        )


@pytest.mark.asyncio
async def test_create_user_success_generates_password(db_session):
    org = await make_org(db_session)
    service = UserService(db_session)
    user, password = await service.create(
        UserCreateRequest(username="ivan", full_name="Ivan Ivanov", role="USER", org_id=org.id),
        actor_id=None,
        actor_ip=None,
    )
    assert user.username == "ivan"
    assert len(password) > 10


@pytest.mark.asyncio
async def test_create_duplicate_username_conflicts(db_session):
    org = await make_org(db_session)
    service = UserService(db_session)
    data = UserCreateRequest(username="ivan", full_name="Ivan Ivanov", role="USER", org_id=org.id)
    await service.create(data, actor_id=None, actor_ip=None)
    with pytest.raises(ConflictError):
        await service.create(data, actor_id=None, actor_ip=None)


@pytest.mark.asyncio
async def test_cannot_delete_last_root(db_session):
    service = UserService(db_session)
    root, _ = await service.create(
        UserCreateRequest(username="root2", full_name="Root Two", role="ROOT", org_id=None),
        actor_id=None,
        actor_ip=None,
    )
    with pytest.raises(ConflictError):
        await service.delete(root.id, actor_id=None, actor_ip=None)


@pytest.mark.asyncio
async def test_reset_password_changes_hash(db_session):
    org = await make_org(db_session)
    service = UserService(db_session)
    user, old_password = await service.create(
        UserCreateRequest(username="ivan", full_name="Ivan Ivanov", role="USER", org_id=org.id),
        actor_id=None,
        actor_ip=None,
    )
    old_hash = user.hashed_password
    new_password = await service.reset_password(user.id, actor_id=None, actor_ip="1.1.1.1")
    assert new_password != old_password
    assert user.hashed_password != old_hash

    logs, _ = await AuditService(db_session).list_all(action="UPDATE")
    assert any(str(log.target_id) == str(user.id) for log in logs)
