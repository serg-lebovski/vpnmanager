FROM python:3.11-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e .

COPY . .

RUN mkdir -p /app/data /app/.ssh && chmod 700 /app/.ssh
ENV HOME=/app

EXPOSE 8000

FROM base AS dev
RUN pip install --no-cache-dir -e ".[dev]"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS final
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
