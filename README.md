# Amnezia VPN Manager

Веб-панель управления VPN-конфигурациями с мульти-тенантностью и автоопределением
типа VPN-бэкенда на сервере (AmneziaWG / wg-easy / plain WireGuard).

Полное техническое задание и обоснования решений — см. [docs/DECISIONS.md](docs/DECISIONS.md)
и [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Быстрый старт

```bash
cp .env.example .env
# сгенерировать ключ шифрования:
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# вставить его в .env как ENCRYPTION_KEY, задать SESSION_SECRET и пароль БД

make up          # docker compose up -d --build
make migrate      # применить Alembic-миграции (уже входит в команду запуска backend)
```

После старта:
- `data/admin_credentials.txt` — логин/пароль ROOT-администратора (создаётся один раз).
- UI — `https://<HOST>/login`.

## Разработка

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
make up
make test    # pytest в контейнере backend
make lint    # ruff + mypy
```

## Стек

FastAPI + SQLAlchemy 2 (async) + PostgreSQL + Alembic + Celery/Redis + Jinja2/HTMX +
Nginx. Подробности — раздел 1 ТЗ и `backend/pyproject.toml`.
