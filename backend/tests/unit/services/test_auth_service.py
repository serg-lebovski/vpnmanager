import pytest

from app.core.exceptions import AuthError
from app.core.passwords import hash_password
from app.models.user import User
from app.services.auth import AuthService, bootstrap_root


async def make_user(db_session, username="ivan", password="secret123", active=True) -> User:
    user = User(
        username=username, full_name="Ivan Ivanov", hashed_password=hash_password(password),
        role="USER", is_active=active,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_authenticate_success(db_session):
    user = await make_user(db_session)
    service = AuthService(db_session)
    authenticated = await service.authenticate("ivan", "secret123", "1.2.3.4")
    assert authenticated.id == user.id
    assert authenticated.last_login_at is not None


@pytest.mark.asyncio
async def test_authenticate_wrong_password_fails(db_session):
    await make_user(db_session)
    service = AuthService(db_session)
    with pytest.raises(AuthError):
        await service.authenticate("ivan", "wrong-password", "1.2.3.4")


@pytest.mark.asyncio
async def test_authenticate_unknown_user_fails(db_session):
    service = AuthService(db_session)
    with pytest.raises(AuthError):
        await service.authenticate("ghost", "whatever", "1.2.3.4")


@pytest.mark.asyncio
async def test_authenticate_inactive_user_fails(db_session):
    await make_user(db_session, active=False)
    service = AuthService(db_session)
    with pytest.raises(AuthError):
        await service.authenticate("ivan", "secret123", "1.2.3.4")


@pytest.mark.asyncio
async def test_bootstrap_root_creates_once(db_session, tmp_path, monkeypatch):
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()

    await bootstrap_root(db_session)
    creds_file = tmp_path / "admin_credentials.txt"
    assert creds_file.exists()
    first_content = creds_file.read_text()

    # Повторный запуск не должен пересоздавать root или перезаписывать файл
    await bootstrap_root(db_session)
    assert creds_file.read_text() == first_content

    get_settings.cache_clear()
