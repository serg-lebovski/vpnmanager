import logging
import re

from app.config import get_settings

_SECRET_KEYS = re.compile(
    r"(password|private_key|preshared_key|config_text|ssh_credential|api_secret|token)",
    re.IGNORECASE,
)
_REDACTED = "***REDACTED***"


class SecretRedactionFilter(logging.Filter):
    """Best-effort scrub of obviously secret-looking key=value pairs in log messages."""

    _KV_PATTERN = re.compile(
        r"(?P<key>\b\w*(?:password|private_key|preshared_key|config_text|"
        r"ssh_credential|api_secret|token)\w*\s*[=:]\s*)(?P<value>\S+)",
        re.IGNORECASE,
    )

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str) and _SECRET_KEYS.search(record.msg):
            record.msg = self._KV_PATTERN.sub(lambda m: f"{m.group('key')}{_REDACTED}", record.msg)
        return True


def configure_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    redaction_filter = SecretRedactionFilter()
    logging.getLogger().addFilter(redaction_filter)
    for handler in logging.getLogger().handlers:
        handler.addFilter(redaction_filter)
