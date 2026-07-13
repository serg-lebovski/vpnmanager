from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.csrf import CSRFMiddleware
from app.core.exceptions import AppError
from app.core.logging import configure_logging
from app.db.session import async_session_factory
from app.routers import (
    auth,
    configs,
    dashboard,
    organizations,
    public,
    servers,
    ui,
    ui_actions,
    users,
)
from app.services.auth import bootstrap_root


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    async with async_session_factory() as session:
        await bootstrap_root(session)
    yield


app = FastAPI(title="Amnezia VPN Manager", lifespan=lifespan)

app.add_middleware(CSRFMiddleware)
app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message, "code": exc.code})


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "code": "HTTP_ERROR"})


app.include_router(auth.router)
app.include_router(servers.router)
app.include_router(organizations.router)
app.include_router(users.router)
app.include_router(configs.router)
app.include_router(dashboard.router)
app.include_router(public.router)
app.include_router(ui.router)
app.include_router(ui_actions.router)
