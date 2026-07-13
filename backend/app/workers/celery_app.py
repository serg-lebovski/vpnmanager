from celery import Celery
from celery.schedules import crontab

from app.config import get_settings

settings = get_settings()

celery_app = Celery("vpnmanager", broker=settings.redis_url, backend=settings.redis_url)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    imports=("app.workers.tasks",),
)

celery_app.conf.beat_schedule = {
    "monitor-servers": {
        "task": "app.workers.tasks.monitor_servers",
        "schedule": 300.0,
    },
    "sync-peer-stats": {
        "task": "app.workers.tasks.sync_peer_stats",
        "schedule": 600.0,
    },
    "redetect-servers": {
        "task": "app.workers.tasks.redetect_servers",
        "schedule": crontab(hour=4, minute=0),
    },
    "cleanup-tokens": {
        "task": "app.workers.tasks.cleanup_tokens",
        "schedule": 900.0,
    },
    "auto-cleanup-configs": {
        "task": "app.workers.tasks.auto_cleanup_configs",
        "schedule": crontab(hour=3, minute=0),
    },
    "purge-revoked": {
        "task": "app.workers.tasks.purge_revoked",
        "schedule": crontab(hour=3, minute=30),
    },
}
