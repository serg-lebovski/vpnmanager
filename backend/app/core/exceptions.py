class AppError(Exception):
    """Базовая ошибка приложения. Роутеры транслируют её в {"detail", "code"}."""

    status_code = 400
    code = "ERROR"

    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code


class NotFoundError(AppError):
    status_code = 404
    code = "NOT_FOUND"


class ConflictError(AppError):
    status_code = 409
    code = "CONFLICT"


class ValidationError(AppError):
    status_code = 422
    code = "VALIDATION_ERROR"


class AuthError(AppError):
    status_code = 401
    code = "AUTH_ERROR"


class ForbiddenError(AppError):
    status_code = 403
    code = "FORBIDDEN"


class RateLimitedError(AppError):
    status_code = 429
    code = "RATE_LIMITED"


class NoAvailableServerError(ConflictError):
    code = "NO_AVAILABLE_SERVER"
