.PHONY: up down restart logs build test lint format migrate revision shell

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose restart backend worker beat

logs:
	docker compose logs -f backend worker beat

build:
	docker compose build

test:
	docker compose run --rm backend pytest

lint:
	docker compose run --rm backend sh -c "ruff check app && mypy app"

format:
	docker compose run --rm backend ruff format app

migrate:
	docker compose run --rm backend alembic upgrade head

revision:
	docker compose run --rm backend alembic revision --autogenerate -m "$(m)"

shell:
	docker compose exec backend bash
