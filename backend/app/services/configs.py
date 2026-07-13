import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.crypto import decrypt, encrypt
from app.core.exceptions import ConflictError, NotFoundError
from app.models.config import Config
from app.models.download_token import DownloadToken
from app.models.enums import UserRole
from app.models.user import User
from app.providers.base import PeerSpec, ProviderError
from app.providers.registry import get_provider
from app.repositories.configs import ConfigRepository
from app.repositories.download_tokens import DownloadTokenRepository
from app.repositories.organizations import OrganizationRepository
from app.repositories.servers import ServerRepository
from app.repositories.users import UserRepository
from app.schemas.configs import ConfigCreateRequest
from app.services.audit import AuditService
from app.services.balancer import Balancer


class ConfigService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = ConfigRepository(session)
        self.servers = ServerRepository(session)
        self.orgs = OrganizationRepository(session)
        self.users = UserRepository(session)
        self.tokens = DownloadTokenRepository(session)
        self.audit = AuditService(session)
        self.balancer = Balancer(session)

    async def get_or_404(self, config_id: uuid.UUID) -> Config:
        config = await self.repo.get_by_id(config_id)
        if not config:
            raise NotFoundError("Config not found")
        return config

    def assert_visible(self, config: Config, current_user: User) -> None:
        if current_user.role == UserRole.USER.value and config.user_id != current_user.id:
            raise NotFoundError("Config not found")

    async def list_all(
        self, current_user: User, user_id: uuid.UUID | None, org_id: uuid.UUID | None,
        server_id: uuid.UUID | None,
    ) -> list[Config]:
        if current_user.role == UserRole.USER.value:
            return await self.repo.list_all(user_id=current_user.id, include_revoked=False)

        org_user_ids = None
        if org_id is not None:
            users = await self.users.list_all(org_id=org_id)
            org_user_ids = [u.id for u, _ in users]
        return await self.repo.list_all(
            user_id=user_id, org_user_ids=org_user_ids, server_id=server_id
        )

    async def create(
        self,
        data: ConfigCreateRequest,
        current_user: User,
        actor_ip: str | None,
    ) -> tuple[Config, str]:
        target_user: User
        if current_user.role == UserRole.USER.value:
            target_user = current_user
        else:
            target_user_id = data.user_id or current_user.id
            found_user = await self.users.get_by_id(target_user_id)
            if not found_user:
                raise NotFoundError("Target user not found")
            target_user = found_user

        if not target_user.org_id:
            raise ConflictError("User has no organization assigned")

        candidate_servers = await self.orgs.get_servers(target_user.org_id)
        chosen_server = await self.balancer.pick_server(candidate_servers)

        used_ips = await self.servers.used_ips(chosen_server.id)
        provider = get_provider(chosen_server)
        spec = PeerSpec(name=f"{target_user.full_name} — {data.label}", public_key=None, preshared_key=None)

        try:
            result = await provider.create_peer(spec, used_ips=used_ips)
        except ProviderError as exc:
            raise ConflictError(f"Failed to create peer on VPN server: {exc}") from exc

        config = Config(
            user_id=target_user.id,
            server_id=chosen_server.id,
            peer_id=result.peer_id,
            device_type=data.device_type,
            label=data.label,
            private_key_encrypted=encrypt(result.private_key) if result.private_key else None,
            public_key=result.peer_id,
            vpn_ip=result.vpn_ip,
            config_text_encrypted=encrypt(result.config_text),
        )
        try:
            self.repo.add(config)
            await self.session.flush()
        except Exception:
            await self.session.rollback()
            try:
                await provider.delete_peer(result.peer_id)
            except ProviderError:
                pass
            raise

        self.audit.log(
            actor_user_id=current_user.id,
            actor_ip=actor_ip,
            action="CREATE",
            target_type="CONFIG",
            target_id=config.id,
            details={"server_id": str(chosen_server.id), "device_type": data.device_type},
        )
        await self.session.commit()
        await self.session.refresh(config)
        return config, result.config_text

    async def delete(self, config_id: uuid.UUID, current_user: User, actor_ip: str | None) -> None:
        config = await self.get_or_404(config_id)
        self.assert_visible(config, current_user)
        server = await self.servers.get_by_id(config.server_id)
        if server and server.provider_type:
            provider = get_provider(server)
            try:
                await provider.delete_peer(config.peer_id)
            except ProviderError:
                pass
        await self.repo.delete(config)
        self.audit.log(
            actor_user_id=current_user.id, actor_ip=actor_ip, action="DELETE",
            target_type="CONFIG", target_id=config_id,
        )
        await self.session.commit()

    async def create_download_link(
        self, config_id: uuid.UUID, current_user: User
    ) -> DownloadToken:
        config = await self.get_or_404(config_id)
        self.assert_visible(config, current_user)
        settings = get_settings()
        token = DownloadToken(
            config_id=config.id,
            expires_at=datetime.now(UTC) + timedelta(hours=settings.download_link_ttl_hours),
            created_by=current_user.id,
        )
        self.tokens.add(token)
        await self.session.commit()
        await self.session.refresh(token)
        return token

    async def recreate(self, config_id: uuid.UUID, current_user: User, actor_ip: str | None) -> Config:
        old_config = await self.get_or_404(config_id)
        self.assert_visible(old_config, current_user)
        if not old_config.needs_recreate:
            raise ConflictError("Config does not need recreation")

        user = await self.users.get_by_id(old_config.user_id)
        if not user or not user.org_id:
            raise ConflictError("User has no organization assigned")

        candidate_servers = [
            s for s in await self.orgs.get_servers(user.org_id) if s.id != old_config.server_id
        ]
        chosen_server = await self.balancer.pick_server(candidate_servers)
        used_ips = await self.servers.used_ips(chosen_server.id)
        provider = get_provider(chosen_server)
        spec = PeerSpec(name=f"{user.full_name} — {old_config.label}", public_key=None, preshared_key=None)

        result = await provider.create_peer(spec, used_ips=used_ips)

        new_config = Config(
            user_id=user.id,
            server_id=chosen_server.id,
            peer_id=result.peer_id,
            device_type=old_config.device_type,
            label=old_config.label,
            private_key_encrypted=encrypt(result.private_key) if result.private_key else None,
            public_key=result.peer_id,
            vpn_ip=result.vpn_ip,
            config_text_encrypted=encrypt(result.config_text),
        )
        self.repo.add(new_config)
        old_config.is_revoked = True
        old_config.needs_recreate = False

        self.audit.log(
            actor_user_id=current_user.id, actor_ip=actor_ip, action="RECREATE",
            target_type="CONFIG", target_id=new_config.id,
            details={"old_config_id": str(old_config.id)},
        )
        await self.session.commit()
        await self.session.refresh(new_config)

        from app.workers.tasks import deferred_delete_peer

        deferred_delete_peer.delay(str(old_config.server_id), old_config.peer_id)
        return new_config

    def decrypt_config_text(self, config: Config) -> str:
        return decrypt(config.config_text_encrypted)
