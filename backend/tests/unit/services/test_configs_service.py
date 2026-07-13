import pytest

import app.services.configs as configs_module
from app.core.crypto import encrypt
from app.core.exceptions import ConflictError, NoAvailableServerError, NotFoundError
from app.models.organization import Organization
from app.models.server import Server
from app.models.user import User
from app.providers.base import PeerResult
from app.schemas.configs import ConfigCreateRequest
from app.services.configs import ConfigService


class FakeProvider:
    def __init__(self, vpn_ip: str = "10.9.0.2") -> None:
        self.vpn_ip = vpn_ip
        self.deleted: list[str] = []

    async def create_peer(self, spec, used_ips=None):
        return PeerResult(
            peer_id="peer-1",
            vpn_ip=self.vpn_ip,
            config_text="[Interface]\nPrivateKey = x\n",
            qr_payload="...",
            private_key="private-key-value",
        )

    async def delete_peer(self, peer_id: str) -> None:
        self.deleted.append(peer_id)


@pytest.fixture(autouse=True)
def patch_provider(monkeypatch):
    fake = FakeProvider()
    monkeypatch.setattr(configs_module, "get_provider", lambda server: fake)
    return fake


async def make_org_with_online_server(db_session) -> tuple[Organization, Server]:
    org = Organization(name="Acme")
    server = Server(
        name="s1",
        endpoint="1.2.3.4",
        status="ONLINE",
        is_active=True,
        ssh_host="1.2.3.4",
        ssh_user="root",
        ssh_credential_encrypted=encrypt("pw"),
        provider_type="wireguard",
    )
    db_session.add_all([org, server])
    await db_session.commit()
    from app.models.organization import OrganizationServer

    db_session.add(OrganizationServer(org_id=org.id, server_id=server.id))
    await db_session.commit()
    return org, server


async def make_user(db_session, org: Organization, username: str = "ivan") -> User:
    user = User(org_id=org.id, username=username, full_name="Ivan Ivanov", hashed_password="x", role="USER")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_create_config_success(db_session):
    org, server = await make_org_with_online_server(db_session)
    user = await make_user(db_session, org)
    service = ConfigService(db_session)

    config, config_text = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
    )
    assert config.vpn_ip == "10.9.0.2"
    assert config.server_id == server.id
    assert "PrivateKey" in config_text


@pytest.mark.asyncio
async def test_user_cannot_see_others_config(db_session):
    org, server = await make_org_with_online_server(db_session)
    owner = await make_user(db_session, org, "owner")
    other = await make_user(db_session, org, "other")
    service = ConfigService(db_session)
    config, _ = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=owner, actor_ip=None
    )

    with pytest.raises(NotFoundError):
        await service.delete(config.id, current_user=other, actor_ip=None)


@pytest.mark.asyncio
async def test_create_config_no_org_conflicts(db_session):
    admin = User(org_id=None, username="admin", full_name="Admin", hashed_password="x", role="ADMIN")
    orphan = User(org_id=None, username="orphan", full_name="Orphan", hashed_password="x", role="USER")
    db_session.add_all([admin, orphan])
    await db_session.commit()
    await db_session.refresh(orphan)
    service = ConfigService(db_session)

    with pytest.raises(ConflictError):
        await service.create(
            ConfigCreateRequest(device_type="PC", label="Laptop", user_id=orphan.id),
            current_user=admin,
            actor_ip=None,
        )


@pytest.mark.asyncio
async def test_delete_config_calls_provider_delete_peer(db_session, patch_provider):
    org, server = await make_org_with_online_server(db_session)
    user = await make_user(db_session, org)
    service = ConfigService(db_session)
    config, _ = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
    )

    await service.delete(config.id, current_user=user, actor_ip=None)
    assert "peer-1" in patch_provider.deleted


@pytest.mark.asyncio
async def test_no_available_server_raises(db_session):
    org = Organization(name="Acme")
    user = User(org_id=None, username="ivan", full_name="Ivan", hashed_password="x", role="USER")
    db_session.add_all([org, user])
    await db_session.commit()
    await db_session.refresh(org)
    user.org_id = org.id
    await db_session.commit()

    service = ConfigService(db_session)
    with pytest.raises(NoAvailableServerError):
        await service.create(
            ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
        )


@pytest.mark.asyncio
async def test_create_download_link(db_session):
    org, server = await make_org_with_online_server(db_session)
    user = await make_user(db_session, org)
    service = ConfigService(db_session)
    config, _ = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
    )

    token = await service.create_download_link(config.id, current_user=user)
    assert token.config_id == config.id
    assert token.used_at is None


@pytest.mark.asyncio
async def test_create_download_link_forbidden_for_other_user(db_session):
    org, server = await make_org_with_online_server(db_session)
    owner = await make_user(db_session, org, "owner")
    other = await make_user(db_session, org, "other")
    service = ConfigService(db_session)
    config, _ = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=owner, actor_ip=None
    )

    with pytest.raises(NotFoundError):
        await service.create_download_link(config.id, current_user=other)


@pytest.mark.asyncio
async def test_recreate_requires_needs_recreate_flag(db_session):
    org, server = await make_org_with_online_server(db_session)
    user = await make_user(db_session, org)
    service = ConfigService(db_session)
    config, _ = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
    )

    with pytest.raises(ConflictError):
        await service.recreate(config.id, current_user=user, actor_ip=None)


@pytest.mark.asyncio
async def test_recreate_creates_new_config_on_another_server(db_session, patch_provider, monkeypatch):
    # dead_server — единственный кандидат на момент создания конфига, чтобы исход был детерминирован
    org, dead_server = await make_org_with_online_server(db_session)
    user = await make_user(db_session, org)
    service = ConfigService(db_session)
    config, _ = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
    )
    assert config.server_id == dead_server.id

    # Сервер падает, добавляется живой сервер той же организации
    live_server = Server(
        name="s2", endpoint="5.6.7.8", status="ONLINE", is_active=True,
        ssh_host="5.6.7.8", ssh_user="root", ssh_credential_encrypted=encrypt("pw"),
        provider_type="wireguard",
    )
    db_session.add(live_server)
    await db_session.commit()
    from app.models.organization import OrganizationServer

    db_session.add(OrganizationServer(org_id=org.id, server_id=live_server.id))
    config.needs_recreate = True
    dead_server.status = "OFFLINE"
    await db_session.commit()

    monkeypatch.setattr("app.workers.tasks.deferred_delete_peer.delay", lambda *a, **kw: None)
    new_config = await service.recreate(config.id, current_user=user, actor_ip=None)

    assert new_config.id != config.id
    assert new_config.server_id == live_server.id
    refreshed = await service.get_or_404(config.id)
    assert refreshed.is_revoked is True


@pytest.mark.asyncio
async def test_decrypt_config_text_roundtrip(db_session):
    org, server = await make_org_with_online_server(db_session)
    user = await make_user(db_session, org)
    service = ConfigService(db_session)
    config, config_text = await service.create(
        ConfigCreateRequest(device_type="PC", label="Laptop"), current_user=user, actor_ip=None
    )
    assert service.decrypt_config_text(config) == config_text
