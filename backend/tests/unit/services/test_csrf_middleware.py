from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app.core.csrf import CSRFMiddleware
from app.core.sessions import CSRF_COOKIE_NAME


async def echo_form(request: Request) -> JSONResponse:
    form = await request.form()
    return JSONResponse({"username": form.get("username"), "password": form.get("password")})


async def echo_json(request: Request) -> JSONResponse:
    data = await request.json()
    return JSONResponse(data)


def make_client() -> TestClient:
    app = Starlette(
        routes=[
            Route("/login", echo_form, methods=["POST"]),
            Route("/api/thing", echo_json, methods=["POST"]),
        ],
        middleware=[],
    )
    app.add_middleware(CSRFMiddleware)
    return TestClient(app)


def test_form_body_reaches_handler_intact_after_csrf_check():
    """Регрессия: BaseHTTPMiddleware-based CSRF ломал Form(...) в FastAPI —
    username/password приходили как "missing" (см. живую проверку на проде)."""
    client = make_client()
    client.cookies.set(CSRF_COOKIE_NAME, "tok123")
    response = client.post(
        "/login",
        data={"username": "root", "password": "secret", "csrf_token": "tok123"},
    )
    assert response.status_code == 200
    assert response.json() == {"username": "root", "password": "secret"}


def test_form_csrf_mismatch_rejected():
    client = make_client()
    client.cookies.set(CSRF_COOKIE_NAME, "tok123")
    response = client.post(
        "/login",
        data={"username": "root", "password": "secret", "csrf_token": "wrong"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "CSRF_ERROR"


def test_json_body_with_header_reaches_handler_intact():
    client = make_client()
    client.cookies.set(CSRF_COOKIE_NAME, "tok123")
    response = client.post(
        "/api/thing",
        json={"foo": "bar"},
        headers={"X-CSRF-Token": "tok123"},
    )
    assert response.status_code == 200
    assert response.json() == {"foo": "bar"}


def test_json_body_without_csrf_header_rejected():
    client = make_client()
    client.cookies.set(CSRF_COOKIE_NAME, "tok123")
    response = client.post("/api/thing", json={"foo": "bar"})
    assert response.status_code == 403
