import secrets
import uuid
from datetime import UTC, datetime, timedelta

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import get_settings

SESSION_COOKIE_NAME = "session"
CSRF_COOKIE_NAME = "csrf_token"


def _serializer() -> URLSafeTimedSerializer:
    settings = get_settings()
    return URLSafeTimedSerializer(settings.session_secret, salt="session")


def create_session_token(user_id: uuid.UUID) -> str:
    return _serializer().dumps({"uid": str(user_id)})


def read_session_token(token: str) -> uuid.UUID | None:
    settings = get_settings()
    try:
        data = _serializer().loads(token, max_age=settings.session_ttl_hours * 3600)
    except (BadSignature, SignatureExpired):
        return None
    try:
        return uuid.UUID(data["uid"])
    except (KeyError, ValueError, TypeError):
        return None


def session_expiry() -> datetime:
    settings = get_settings()
    return datetime.now(UTC) + timedelta(hours=settings.session_ttl_hours)


def generate_csrf_token() -> str:
    return secrets.token_urlsafe(32)
