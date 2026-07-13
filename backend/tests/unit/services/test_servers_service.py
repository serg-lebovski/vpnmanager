from datetime import UTC, datetime

import pytest

import app.services.servers as servers_module
from app.core.exceptions import ConflictError
from app.providers.detector import DetectionResult
from app.schemas.organizations import OrganizationCreateRequest
from app.schemas.servers import ServerCreateRequest, ServerUpdateRequest
from app.services.audit import AuditService
from app.services.organizations import OrganizationService
from app.services.servers import ServerService


class FakeDetector:
    def __init__(self, creds) -> None:
        pass

    async def detect(self) -> DetectionResult:
        return DetectionResult(
            status="ONLINE",
            provider_type="wireguard",
            wg_interface="wg0",
            wg_port=51820,
            server_public_key="pubkey",
            subnet="10.9.0.0/24",
            capabilities={"obfuscation": None},
            detected_at=datetime.now(UTC),
        )


@pytest.fixture(autouse=True)
def patch_detector(monkeypatch):
    monkeypatch.setattr(servers_module, "ServerDetector", FakeDetector)


@pytest.mark.asyncio
async def test_create_server_runs_detection_and_sets_status(db_session):
    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )
    assert server.status == "ONLINE"
    assert server.provider_type == "wireguard"
    assert server.subnet == "10.9.0.0/24"


@pytest.mark.asyncio
async def test_cannot_delete_server_linked_to_org(db_session):
    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )
    org_service = OrganizationService(db_session)
    org = await org_service.create(OrganizationCreateRequest(name="Acme"), actor_id=None, actor_ip=None)
    await org_service.set_servers(org.id, [server.id])

    with pytest.raises(ConflictError):
        await service.delete(server.id)


@pytest.mark.asyncio
async def test_update_server_fields(db_session):
    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )
    updated = await service.update(
        server.id, ServerUpdateRequest(weight=5, is_active=False), actor_id=None, actor_ip="9.9.9.9"
    )
    assert updated.weight == 5
    assert updated.is_active is False

    logs, _ = await AuditService(db_session).list_all(action="UPDATE")
    assert any(str(log.target_id) == str(server.id) for log in logs)


@pytest.mark.asyncio
async def test_delete_server_writes_audit_log(db_session):
    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )
    await service.delete(server.id, actor_id=None, actor_ip="9.9.9.9")

    logs, _ = await AuditService(db_session).list_all(action="DELETE")
    assert any(str(log.target_id) == str(server.id) for log in logs)


@pytest.mark.asyncio
async def test_redetect_updates_server(db_session):
    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )
    redetected = await service.redetect(server.id, actor_id=None, actor_ip=None)
    assert redetected.provider_type == "wireguard"
    assert redetected.detected_at is not None


@pytest.mark.asyncio
async def test_test_server_health_check(db_session, monkeypatch):
    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )

    class FakeProvider:
        async def health_check(self):
            return True

    monkeypatch.setattr(servers_module, "get_provider", lambda s: FakeProvider())
    healthy = await service.test(server.id)
    assert healthy is True
    refreshed = await service.get_or_404(server.id)
    assert refreshed.status == "ONLINE"


@pytest.mark.asyncio
async def test_rotate_keys_not_supported_propagates(db_session, monkeypatch):
    from app.providers.base import NotSupportedError

    service = ServerService(db_session)
    server = await service.create(
        ServerCreateRequest(name="srv1", endpoint="1.2.3.4", ssh_user="root", ssh_password="pw"),
        actor_id=None,
        actor_ip=None,
    )

    class FakeProvider:
        async def rotate_keys(self):
            raise NotSupportedError("nope")

    monkeypatch.setattr(servers_module, "get_provider", lambda s: FakeProvider())
    with pytest.raises(NotSupportedError):
        await service.rotate_keys(server.id)
