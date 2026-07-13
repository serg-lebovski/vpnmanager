# Как добавить новый VPN-провайдер

Абстракция описана в `backend/app/providers/base.py`. Сервисный слой (`app/services/`)
знает **только** интерфейс `VPNProvider` — никогда не импортирует конкретную
реализацию напрямую. Выбор реализации происходит в одном месте — `registry.py`.

## Контракт

```python
class VPNProvider(ABC):
    provider_type: str

    async def health_check(self) -> bool: ...
    async def create_peer(self, spec: PeerSpec, used_ips: set[str] | None = None) -> PeerResult: ...
    async def delete_peer(self, peer_id: str) -> None: ...
    async def list_peers(self) -> list[PeerStat]: ...
    async def get_stats(self) -> list[PeerStat]: ...
    async def rotate_keys(self) -> None: ...  # raise NotSupportedError, если не поддерживается
```

`used_ips` нужен только тем провайдерам, которые сами выбирают IP из подсети
(`amnezia_wg`, `wireguard`); провайдеры, где адрес назначает сам бэкенд (`wg_easy`),
параметр игнорируют.

Ошибки — `ProviderError` / `ProviderUnreachable` / `ProviderAuthError` /
`NotSupportedError` (все в `base.py`). Сервисный слой ловит только эти типы.

## Шаги добавления нового бэкенда

1. **Создать файл** `app/providers/<name>.py` с классом, наследующим `VPNProvider`.
   Смотрите `wireguard.py` как минимальный пример (SSH-управление) или `wg_easy.py`
   (HTTP API поверх SSH-туннеля).
2. **Добавить строку в `registry.py`**:
   ```python
   def _build_<name>(server) -> VPNProvider:
       creds = _build_ssh_credentials(server)
       ...
       return <Name>Provider(creds, ...)

   _FACTORIES["<name>"] = _build_<name>
   ```
   Больше никаких правок в `services/` не требуется — они работают с `VPNProvider`
   через `get_provider(server)`.
3. **Научить детектор** (`detector.py`) находить новый бэкенд: добавить шаг
   `_check_<name>()` в `ServerDetector.detect()` и вписать провайдер в `PRIORITY`
   (порядок — какой бэкенд выигрывает, если сервер подходит под несколько).
4. **Юнит-тесты**:
   - `tests/unit/providers/test_<name>.py` — `create_peer`/`delete_peer`/`get_stats`
     с мокнутым SSH (см. `FakeConnection`/`FakeSSHClient` в `test_amnezia_wg.py`) или
     мокнутым HTTP (`FakeAsyncClient` в `test_wg_easy.py`, через
     `monkeypatch.setattr(<module>.httpx, "AsyncClient", FakeAsyncClient)`).
   - Добавить сценарий в `tests/unit/providers/test_detector.py`.
5. **`docs/PROVIDERS.md`** — обновить этот файл, если появился новый паттерн
   аутентификации/обнаружения, которого тут ещё нет.

## Что нельзя делать

- Провайдеры не импортируют `app/services/*` и `app/repositories/*` — они ничего не
  знают о БД. Всё нужное (например, `used_ips`) сервисный слой передаёт параметрами.
- Секреты (пароли, приватные ключи) в провайдер приходят уже расшифрованными
  (`registry.py` вызывает `app.core.crypto.decrypt`), провайдер их никогда не логирует.
- SSH-команды — только через `SSHClient`/`conn.run(...)` с параметризацией
  (`shlex.quote` в `ssh_utils.SSHClient.run`, либо явный список аргументов). Никакой
  конкатенации пользовательского ввода в shell-строку.
