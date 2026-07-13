import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, password)
    except VerifyMismatchError:
        return False


def generate_password(nbytes: int = 18) -> str:
    """secrets.token_urlsafe(18) yields a 24-character token, per spec."""
    return secrets.token_urlsafe(nbytes)
