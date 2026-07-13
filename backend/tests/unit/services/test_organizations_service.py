import pytest

from app.core.crypto import encrypt
from app.core.exceptions import ConflictError
from app.models.server import Server
from app.models.user import User
from app.schemas.organizations import OrganizationCreateRequest
from app.services.organizations import OrganizationService


def make_server(name: str) -> Server:
    return Server(
        name=name,
        endpoint="1.2.3.4",
        status="ONLINE",
        ssh_host="1.2.3.4",
        ssh_user="root",
        ssh_credential_encrypted=encrypt("pw"),
        provider_type="wireguard",
    )


@pytest.mark.asyncio
async def test_create_duplicate_name_conflicts(db_session):
    service = OrganizationService(db_session)
    await service.create(OrganizationCreateRequest(name="Acme"), actor_id=None, actor_ip=None)
    with pytest.raises(ConflictError):
        await service.create(OrganizationCreateRequest(name="Acme"), actor_id=None, actor_ip=None)


@pytest.mark.asyncio
async def test_cannot_delete_org_with_users(db_session):
    service = OrganizationService(db_session)
    org = await service.create(OrganizationCreateRequest(name="Acme"), actor_id=None, actor_ip=None)
    db_session.add(
        User(org_id=org.id, username="u1", full_name="U1", hashed_password="x", role="USER")
    )
    await db_session.commit()

    with pytest.raises(ConflictError):
        await service.delete(org.id)


@pytest.mark.asyncio
async def test_set_servers_replaces_links(db_session):
    service = OrganizationService(db_session)
    org = await service.create(OrganizationCreateRequest(name="Acme"), actor_id=None, actor_ip=None)
    s1, s2 = make_server("s1"), make_server("s2")
    db_session.add_all([s1, s2])
    await db_session.commit()

    await service.set_servers(org.id, [s1.id, s2.id])
    servers = await service.repo.get_servers(org.id)
    assert {s.id for s in servers} == {s1.id, s2.id}

    await service.set_servers(org.id, [s1.id])
    servers = await service.repo.get_servers(org.id)
    assert {s.id for s in servers} == {s1.id}


@pytest.mark.asyncio
async def test_stats_counts_servers_users_configs(db_session):
    service = OrganizationService(db_session)
    org = await service.create(OrganizationCreateRequest(name="Acme"), actor_id=None, actor_ip=None)
    s1 = make_server("s1")
    db_session.add(s1)
    await db_session.commit()
    await service.set_servers(org.id, [s1.id])

    stats = await service.stats(org.id)
    assert stats["servers_count"] == 1
    assert stats["users_count"] == 0
    assert stats["configs_count"] == 0
