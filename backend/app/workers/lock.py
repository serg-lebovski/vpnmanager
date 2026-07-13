from contextlib import contextmanager

import redis as sync_redis

from app.config import get_settings

_settings = get_settings()
_redis_client = sync_redis.from_url(_settings.redis_url, decode_responses=True)


@contextmanager
def task_lock(name: str, key: str, timeout: int = 600):
    """Не даёт одноимённой задаче выполняться параллельно для одного и того же key."""
    lock = _redis_client.lock(f"task:{name}:{key}", timeout=timeout, blocking=False)
    acquired = lock.acquire(blocking=False)
    try:
        yield acquired
    finally:
        if acquired:
            try:
                lock.release()
            except sync_redis.exceptions.LockError:
                pass
