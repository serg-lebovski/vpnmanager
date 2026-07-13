"""CSRF: double-submit cookie. Cookie выставляется при логине, форма/HTMX шлёт его же
значение в поле csrf_token (form) или заголовке X-CSRF-Token — должны совпадать."""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.core.sessions import CSRF_COOKIE_NAME

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
EXEMPT_PATHS_PREFIXES = ("/api/auth/login", "/d/")


class CSRFMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method not in SAFE_METHODS and not request.url.path.startswith(
            EXEMPT_PATHS_PREFIXES
        ):
            cookie_token = request.cookies.get(CSRF_COOKIE_NAME)
            header_token: str | None = request.headers.get("x-csrf-token")
            if not header_token:
                content_type = request.headers.get("content-type", "")
                if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
                    form = await request.form()
                    form_value = form.get("csrf_token")
                    header_token = form_value if isinstance(form_value, str) else None
            if not cookie_token or not header_token or cookie_token != header_token:
                return JSONResponse(
                    {"detail": "CSRF token missing or invalid", "code": "CSRF_ERROR"},
                    status_code=403,
                )
        return await call_next(request)
