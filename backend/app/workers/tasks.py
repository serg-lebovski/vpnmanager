import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.config import get_settings
from app.db.session import async_session_factory
from app.models.config import Config
from app.models.download_token import DownloadToken
from app.models.organization import Organization
from app.models.server import Server
from app.providers.base import ProviderError
from app.providers.detector import ServerDetector
from app.providers.registry import get_provider
from app.providers.ssh_utils import SSHCredentials
from app.workers.celery_app import celery_app
from app.workers.lock import task_lock


def _run(coro):
    return asyncio.run(coro)


@celery_app.task(name="app.workers.tasks.monitor_servers")
def monitor_servers() -> None:
    _run(_monitor_servers())


async def _monitor_servers() -> None:
    settings = get_settings()
    async with async_session_factory() as session:
        servers = list((await session.execute(select(Server))).scalars().all())
        for server in servers:
            with task_lock("monitor_servers", str(server.id)) as acquired:
                if not acquired:
                    continue
                if not server.provider_type:
                    continue
                try:
                    provider = get_provider(server)
                    healthy = await provider.health_check()
                except ProviderError:
                    healthy = False

                now = datetime.now(UTC)
                server.last_checked_at = now
                if healthy:
                    server.status = "ONLINE"
                    server.offline_since = None
                else:
                    server.status = "OFFLINE"
                    if server.offline_since is None:
                        server.offline_since = now
                    elif now - server.offline_since > timedelta(hours=settings.offline_threshold_hours):
                        await _mark_configs_for_recreate(session, server.id)
        await session.commit()


async def _mark_configs_for_recreate(session, server_id) -> None:
    configs = list(
        (
            await session.execute(
                select(Config).where(Config.server_id == server_id, Config.is_revoked.is_(False))
            )
        ).scalars().all()
    )
    for config in configs:
        config.needs_recreate = True
        config.is_revoked = True


@celery_app.task(name="app.workers.tasks.sync_peer_stats")
def sync_peer_stats() -> None:
    _run(_sync_peer_stats())


async def _sync_peer_stats() -> None:
    async with async_session_factory() as session:
        servers = list((await session.execute(select(Server))).scalars().all())
        for server in servers:
            if server.status != "ONLINE" or not server.provider_type:
                continue
            with task_lock("sync_peer_stats", str(server.id)) as acquired:
                if not acquired:
                    continue
                try:
                    provider = get_provider(server)
                    stats = await provider.get_stats()
                except ProviderError:
                    continue
                stats_by_peer = {s.peer_id: s for s in stats}
                configs = list(
                    (
                        await session.execute(
                            select(Config).where(Config.server_id == server.id)
                        )
                    ).scalars().all()
                )
                for config in configs:
                    stat = stats_by_peer.get(config.peer_id)
                    if not stat:
                        continue
                    config.last_handshake = stat.last_handshake
                    config.rx_bytes = stat.rx_bytes
                    config.tx_bytes = stat.tx_bytes
        await session.commit()


@celery_app.task(name="app.workers.tasks.redetect_servers")
def redetect_servers() -> None:
    _run(_redetect_servers())


async def _redetect_servers() -> None:
    from app.core.crypto import decrypt

    async with async_session_factory() as session:
        servers = list((await session.execute(select(Server))).scalars().all())
        for server in servers:
            with task_lock("redetect_servers", str(server.id)) as acquired:
                if not acquired:
                    continue
                secret = decrypt(server.ssh_credential_encrypted)
                is_private_key = "PRIVATE KEY" in secret
                creds = SSHCredentials(
                    host=server.ssh_host,
                    port=server.ssh_port,
                    username=server.ssh_user,
                    private_key=secret if is_private_key else None,
                    password=None if is_private_key else secret,
                )
                result = await ServerDetector(creds).detect()
                server.status = result.status
                server.provider_type = result.provider_type
                server.wg_interface = result.wg_interface
                server.wg_port = result.wg_port
                server.server_public_key = result.server_public_key
                server.subnet = result.subnet
                server.capabilities = result.capabilities
                server.detected_at = result.detected_at
                server.detection_error = result.detection_error
                server.last_checked_at = datetime.now(UTC)
        await session.commit()


@celery_app.task(name="app.workers.tasks.cleanup_tokens")
def cleanup_tokens() -> None:
    _run(_cleanup_tokens())


async def _cleanup_tokens() -> None:
    async with async_session_factory() as session:
        now = datetime.now(UTC)
        tokens = list(
            (
                await session.execute(
                    select(DownloadToken).where(
                        (DownloadToken.expires_at < now) | (DownloadToken.used_at.is_not(None))
                    )
                )
            ).scalars().all()
        )
        for token in tokens:
            await session.delete(token)
        await session.commit()


@celery_app.task(name="app.workers.tasks.auto_cleanup_configs")
def auto_cleanup_configs() -> None:
    _run(_auto_cleanup_configs())


async def _auto_cleanup_configs() -> None:
    async with async_session_factory() as session:
        orgs = list(
            (
                await session.execute(
                    select(Organization).where(Organization.auto_cleanup_days.is_not(None))
                )
            ).scalars().all()
        )
        for org in orgs:
            from app.models.user import User

            if org.auto_cleanup_days is None:
                continue
            cutoff = datetime.now(UTC) - timedelta(days=org.auto_cleanup_days)
            user_ids = list(
                (
                    await session.execute(select(User.id).where(User.org_id == org.id))
                ).scalars().all()
            )
            if not user_ids:
                continue
            stale_configs = list(
                (
                    await session.execute(
                        select(Config).where(
                            Config.user_id.in_(user_ids),
                            Config.is_revoked.is_(False),
                            (
                                (Config.last_handshake.is_not(None) & (Config.last_handshake < cutoff))
                                | (Config.last_handshake.is_(None) & (Config.created_at < cutoff))
                            ),
                        )
                    )
                ).scalars().all()
            )
            for config in stale_configs:
                server = await session.get(Server, config.server_id)
                if server and server.provider_type:
                    try:
                        provider = get_provider(server)
                        await provider.delete_peer(config.peer_id)
                    except ProviderError:
                        pass
                await session.delete(config)
        await session.commit()


@celery_app.task(name="app.workers.tasks.purge_revoked")
def purge_revoked() -> None:
    _run(_purge_revoked())


async def _purge_revoked() -> None:
    settings = get_settings()
    async with async_session_factory() as session:
        cutoff = datetime.now(UTC) - timedelta(days=settings.purge_revoked_days)
        configs = list(
            (
                await session.execute(
                    select(Config).where(Config.is_revoked.is_(True), Config.created_at < cutoff)
                )
            ).scalars().all()
        )
        for config in configs:
            await session.delete(config)
        await session.commit()


@celery_app.task(
    name="app.workers.tasks.deferred_delete_peer",
    bind=True,
    max_retries=100,
    default_retry_delay=300,
)
def deferred_delete_peer(self, server_id: str, peer_id: str) -> None:
    try:
        _run(_deferred_delete_peer(server_id, peer_id))
    except ProviderError as exc:
        raise self.retry(exc=exc) from exc


async def _deferred_delete_peer(server_id: str, peer_id: str) -> None:
    async with async_session_factory() as session:
        server = await session.get(Server, server_id)
        if not server or server.status != "ONLINE":
            raise ProviderError("Server not back online yet")
        provider = get_provider(server)
        await provider.delete_peer(peer_id)


@celery_app.task(name="app.workers.tasks.notify")
def notify(message: str) -> None:
    """Заглушка отправки уведомлений (Telegram/SMTP) — расширяется по мере необходимости."""
    settings = get_settings()
    if settings.telegram_bot_token and settings.telegram_chat_id:
        import httpx

        httpx.post(
            f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
            json={"chat_id": settings.telegram_chat_id, "text": message},
            timeout=10.0,
        )
