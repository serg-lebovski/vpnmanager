"""CSRF: double-submit cookie. Cookie выставляется при логине, форма/HTMX шлёт его же
значение в поле csrf_token (form) или заголовке X-CSRF-Token — должны совпадать.

Реализовано как "чистый" ASGI-middleware (а не BaseHTTPMiddleware): чтение тела запроса
для form-based проверки требует буферизации и последующего "воспроизведения" тех же
байтов для нижестоящего приложения — BaseHTTPMiddleware этого не делает и ломает
разбор Form(...) в FastAPI-обработчиках (username/password приходили как "missing").
"""

from urllib.parse import parse_qsl

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.sessions import CSRF_COOKIE_NAME

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
EXEMPT_PATHS_PREFIXES = ("/api/auth/login", "/d/")


class CSRFMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        if request.method in SAFE_METHODS or request.url.path.startswith(EXEMPT_PATHS_PREFIXES):
            await self.app(scope, receive, send)
            return

        cookie_token = request.cookies.get(CSRF_COOKIE_NAME)
        header_token = request.headers.get("x-csrf-token")

        body = b""
        if not header_token:
            content_type = request.headers.get("content-type", "")
            if "application/x-www-form-urlencoded" in content_type:
                body, receive = await self._buffer_body(receive)
                fields = dict(parse_qsl(body.decode("utf-8", errors="replace")))
                header_token = fields.get("csrf_token")

        if not cookie_token or not header_token or cookie_token != header_token:
            response = JSONResponse(
                {"detail": "CSRF token missing or invalid", "code": "CSRF_ERROR"},
                status_code=403,
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)

    @staticmethod
    async def _buffer_body(receive: Receive) -> tuple[bytes, Receive]:
        """Читает тело запроса целиком и возвращает receive-заглушку, которая
        "проигрывает" те же байты нижестоящему приложению."""
        chunks = []
        more_body = True
        while more_body:
            message = await receive()
            chunks.append(message.get("body", b""))
            more_body = message.get("more_body", False)
        body = b"".join(chunks)

        async def replay_receive() -> Message:
            return {"type": "http.request", "body": body, "more_body": False}

        return body, replay_receive
