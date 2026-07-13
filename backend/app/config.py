from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "production"
    log_level: str = "INFO"
    host: str = "localhost"

    database_url: str = "postgresql+asyncpg://vpnmanager:vpnmanager@db:5432/vpnmanager"
    redis_url: str = "redis://redis:6379/0"

    encryption_key: str
    session_secret: str
    session_ttl_hours: int = 12

    login_rate_limit: str = "5/5minutes"
    download_rate_limit: str = "20/minute"

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""

    download_link_ttl_hours: int = 2
    offline_threshold_hours: int = 48
    purge_revoked_days: int = 30

    data_dir: str = "/app/data"
    ssh_known_hosts_path: str = "/app/.ssh/known_hosts"

    @property
    def is_dev(self) -> bool:
        return self.env == "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
