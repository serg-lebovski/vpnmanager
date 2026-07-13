import re
from functools import lru_cache

import redis.asyncio as aioredis

from app.config import get_settings


class RateLimitExceeded(Exception):
    pass


@lru_cache
def _redis() -> aioredis.Redis:
    settings = get_settings()
    return aioredis.from_url(settings.redis_url, decode_responses=True)


def _parse_limit(spec: str) -> tuple[int, int]:
    """'5/5minutes' -> (5, 300); '20/minute' -> (20, 60)."""
    match = re.match(r"^(\d+)/(\d+)?\s*(second|minute|hour)s?$", spec.strip())
    if not match:
        raise ValueError(f"Invalid rate limit spec: {spec}")
    count = int(match.group(1))
    multiplier = int(match.group(2)) if match.group(2) else 1
    unit_seconds = {"second": 1, "minute": 60, "hour": 3600}[match.group(3)]
    return count, multiplier * unit_seconds


async def check_rate_limit(key: str, spec: str) -> None:
    """Raises RateLimitExceeded if the fixed-window counter for `key` is exceeded."""
    count, window_seconds = _parse_limit(spec)
    redis_client = _redis()
    current = await redis_client.incr(key)
    if current == 1:
        await redis_client.expire(key, window_seconds)
    if current > count:
        raise RateLimitExceeded(f"Rate limit exceeded: {spec}")
