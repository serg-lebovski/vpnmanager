# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

VPN Manager — веб-сервис для управления VPN-серверами на клиентских VPS: подключение по SSH,
установка WireGuard/AmneziaWG, управление peers, балансировка нагрузки между несколькими VPS,
мультитенантность (аккаунты клиентских организаций). Подробное описание доменной логики,
пользовательских сценариев и известных эксплуатационных ограничений — в [README.md](README.md);
прочти его перед серьёзными изменениями в `vpn/`, `servers/` или `bridges/` — там задокументированы
несколько уже отловленных production-инцидентов (например, порча конфига для `execContainer`-протоколов,
segfault `wg-quick` под systemd в некоторых окружениях) и почему код сейчас обходит их именно так.

Стек: NestJS + TypeScript + TypeORM/PostgreSQL на бэкенде, React + Vite + TypeScript + MUI на
фронтенде, `node-ssh` для управления VPS, Docker Compose + Nginx для деплоя.

Репозиторий — git-репозиторий с remote `origin` (github.com/serg-lebovski/vpnmanager), основная
ветка `main`; `git log`/`git blame` можно использовать для истории изменений.

## Команды разработки

Нет тестов и нет настроенного eslint-конфига в репозитории (скрипт `lint` в backend/package.json
есть, но конфиг отсутствует) — не пытайся запускать `npm run lint` или `npm test`, их сейчас нет.

```bash
# backend (слушает :3000)
cd backend && npm install && npm run start:dev   # nest start --watch
cd backend && npm run build                       # nest build
cd backend && npm run start                        # node dist/main.js, после build

# frontend (dev-сервер :5173, проксирует /api никуда сам не проксирует — см. nginx для прод-роутинга)
cd frontend && npm install && npm run dev
cd frontend && npm run build     # tsc -b && vite build
cd frontend && npm run preview
```

Для локального запуска backend нужен свой Postgres и переменные окружения `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, `APP_ENCRYPTION_KEY` (см. `.env.example`) —
приложение падает при старте, если `APP_ENCRYPTION_KEY` не задан или короче 16 символов
(`common/encryption.util.ts`), и `ConfigService.getOrThrow` кидает при отсутствии остальных DB_*.

Полный стек через Docker Compose:

```bash
cp .env.example .env   # заполнить секреты: APP_ENCRYPTION_KEY, JWT_SECRET, POSTGRES_PASSWORD, SEED_ADMIN_PASSWORD
docker compose up -d --build
```

## Архитектура backend (`backend/src`)

NestJS-модули, по одному на предметную область: `auth`, `organizations`, `users`, `servers`,
`peers`, `bridges`, `vpn`, `ssh`, `load-balancer`, `database`, плюс `common` (guards, decorators,
enums, шифрование, exception filter). Все они собраны в `app.module.ts`.

**Слой абстракции над VPN-протоколом** — ключевая часть архитектуры:

- `vpn/vpn-driver.interface.ts` определяет интерфейс `VpnDriver`: `install`, `scanExistingPeers`,
  `applyPeers`, `getActivePeerCount`, `detectExisting`, `connectAsClient`/`disconnectAsClient`
  (для режима моста) и `ensureClientToolsInstalled`.
- `vpn/wireguard.driver.ts` и `vpn/amnezia-wg.driver.ts` реализуют этот интерфейс поверх общей
  базы `vpn/base-wireguard-like.driver.ts` (протоколы совместимы по формату конфига/CLI).
- `vpn/vpn-provisioning.service.ts` — фасад, который по `VpnProtocol` выбирает нужный драйвер и
  выполняет операции через `SshService.withConnection` (открывает SSH-сессию на VPS клиента,
  выполняет команды, закрывает). Все реальные SSH-команды на VPS идут только через этот путь.
- Чтобы добавить новый VPN-протокол: реализовать `VpnDriver`, зарегистрировать в
  `VpnProvisioningService.drivers` и в enum `VpnProtocol` (`common/enums.ts`).

**Многосерверность и балансировка**: сущность `ServerProtocol` (`servers/server-protocol.entity.ts`)
— это конкретный установленный протокол на конкретном `Server`, со своим `status`
(`not_installed`/`installing`/`active`/`error`), `interfaceName`, `networkCidr`, `nextHostOctet`
(следующий свободный IP в подсети). `LoadBalancerService.pickServerProtocol` выбирает наименее
загруженный ACTIVE `ServerProtocol` данного протокола при создании нового peer (считает активные
peers по каждому кандидату, отсекает те, что на пределе `server.maxPeers`).

**Мультитенантность**: `Organization` → `User` (роли `super_admin`/`org_admin`/`org_user`,
enum `Role`) → `Peer`. Скоуп по организации применяется в сервисах (не на уровне БД/RLS) — см.
паттерн в `peers/peers.service.ts` (`resolveOrganizationId`, `findAllForRequester`): супер-админ
видит/фильтрует по любой организации, `org_admin`/`org_user` видят только свою
(`requester.organizationId`). При добавлении новых сущностей с organization-scoping следуй тому же
паттерну, а не полагайся на guard'ы для фильтрации данных.

**Авторизация**: JWT (`@nestjs/passport` + `passport-jwt`, `auth/jwt.strategy.ts`) с access+refresh
токенами (`JWT_ACCESS_TTL`/`JWT_REFRESH_TTL`). `common/guards/jwt-auth.guard.ts` проверяет токен,
`common/guards/roles.guard.ts` + `@Roles(...)` декоратор (`common/decorators/roles.decorator.ts`)
проверяют роль. `@CurrentUser()` (`common/decorators/current-user.decorator.ts`) достаёт
`AuthenticatedUser` из request. Роли и organization-scoping — два независимых слоя проверки,
обычно нужны оба.

**Шифрование секретов**: `common/encryption.util.ts` — AES-256-GCM, ключ выводится из
`APP_ENCRYPTION_KEY` через `scryptSync` с фиксированной солью. Используется для SSH-паролей/ключей
на `Server` и приватных ключей peers в БД (`encryptSecret`/`decryptSecret`). Формат хранения:
`iv:authTag:ciphertext` в hex, через `:`.

**Режим моста** (`bridges/`) — панель поднимает WireGuard/AmneziaWG на собственном хосте
(self-сервер), клиенты подключаются к нему напрямую, а сам мост работает клиентом к одному из уже
добавленных backend-серверов через `VpnDriver.connectAsClient`. Один self-сервер может нести
**несколько мостов** (в т.ч. с разными организациями `Bridge.organizationId`, `null` — общий мост,
виден только суперадмину), и один мост может выдавать клиентам сразу оба протокола
(`wireguardClientProtocol`/`amneziawgClientProtocol` — независимые `ServerProtocol`, оба
маршрутизируются через один и тот же upstream). Чтобы несколько мостов на одном self-сервере не
конфликтовали за один netdev/таблицу маршрутов, у каждого моста свой случайно сгенерированный
`upstreamInterfaceName` и своя `routeTable` (выделяется как `MAX(routeTable)+1` по всем мостам,
`bridges.service.ts#allocateRouteTable`); маршрут по умолчанию на upstream добавляется только в эту
таблицу, а не в основную таблицу хоста. `BridgesService` держит `@Interval(5 * 60 * 1000)` джобу
(`@nestjs/schedule`) для авто-переключения upstream при режиме `auto` — сравнивает нагрузку текущего
upstream с другими ACTIVE серверами того же протокола (порог `REBALANCE_THRESHOLD = 0.2`). NAT/
forwarding между клиентскими интерфейсами моста и upstream-интерфейсом настраивается один раз через
`VpnProvisioningService.setupBridgeNat` (iptables-правила ссылаются на имена интерфейсов, которые не
меняются при последующих переключениях upstream — поэтому не нужно их пересоздавать при auto-switch).
Апстрим-peer моста имеет `PeerSource.BRIDGE_UPSTREAM` и не показывается в обычных списках peers.
Self-серверы скрыты из списка «Серверы (VPS)» на фронтенде (`Server.isSelf`, фильтр в
`ServersPage.tsx`) — ими управляют только через вкладку «Мост». Удаление backend-сервера сначала
вызывает `BridgesService.reassignUpstreamAwayFrom` (переключает зависящие от него мосты на другой
ACTIVE сервер того же протокола, best-effort по каждому мосту), иначе после `ON DELETE SET NULL`
мост завис бы без upstream без возможности починки кроме как вручную; удаление самого моста
(`BridgesService.remove`) отзывает системный upstream-peer и удаляет клиентские `ServerProtocol`
моста.

**База данных**: TypeORM работает в режиме `synchronize: true` (`app.module.ts`) — миграций нет,
схема выводится из entity-декораторов автоматически при старте. `database/seed.service.ts` создаёт
суперадмина из `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` при первом старте, если в БД ещё нет
пользователей.

**Валидация**: глобальный `ValidationPipe` с `whitelist: true, forbidNonWhitelisted: true` —
DTO в `*/dto/*.dto.ts` должны точно описывать допустимые поля запроса, лишние поля отклоняются.

## Архитектура frontend (`frontend/src`)

- `api/` — по одному модулю на backend-ресурс (`auth.ts`, `servers.ts`, `peers.ts`,
  `organizations.ts`, `users.ts`, `bridges.ts`), плюс общий `client.ts` (axios-инстанс с
  interceptor'ами) и `types.ts`. Все запросы идут на `/api` (relative), в проде это резолвится
  nginx'ом в `backend:3000`, в dev-режиме нужен свой прокси/CORS — сейчас `main.ts` бэкенда
  включает `app.enableCors()` без ограничений.
- `client.ts` реализует авто-обновление access-токена: 401 → пробует `POST /api/auth/refresh` с
  refresh-токеном из `auth/tokenStorage.ts`, ретраит исходный запрос; при неудаче чистит токены и
  редиректит на `/login`. Конкурентные запросы разделяют один `refreshPromise`, чтобы не слать
  несколько параллельных refresh при массовом 401.
- `auth/AuthContext.tsx` + `auth/ProtectedRoute.tsx` — состояние аутентификации и защита роутов.
- `pages/` — по странице на раздел UI: `ServersPage`, `PeersPage`, `OrganizationsPage`,
  `UsersPage`, `BridgePage`, `LoginPage`, обёрнутые в `DashboardLayout`.
- Data-fetching через `@tanstack/react-query`, UI — MUI (`@mui/material`).

## Деплой

`docker-compose.yml` поднимает 4 сервиса: `postgres`, `backend` (build из `backend/Dockerfile`),
`frontend` (build из `frontend/Dockerfile`, отдаёт статику), `nginx` (единственный сервис с внешним
портом, `nginx/nginx.conf` проксирует `/api/` → `backend:3000/`, всё остальное → `frontend:80`).
`backend` ждёт `postgres` healthy (`pg_isready`) через `depends_on.condition: service_healthy`.

Известные эксплуатационные ограничения (подробности и причины — в README.md, раздел «Известные
ограничения MVP»): поддерживаются только сети `a.b.c.0/24`; TLS не настроен; установка AmneziaWG
зависит от внешнего PPA и может не собраться под конкретное ядро/дистрибутив; self-сервер моста в
непривилегированном LXC-контейнере не может поднять реальный WireGuard-интерфейс.

**Модуль `system/`** (бэкенд, `@Roles(SUPER_ADMIN)`) — вкладка «Настройки»: `backup.service.ts`
стримит `pg_dump` прямо в HTTP-ответ; `update.service.ts` запускает `git pull` +
`docker compose up -d --build` изнутри backend-контейнера через смонтированный
`/var/run/docker.sock` хоста (Docker-outside-of-Docker, root-эквивалент — осознанный компромисс,
подробности и как отключить — в README.md, раздел «Настройки сервера»). `REPO_PATH` в
`docker-compose.yml` (`${PWD}`) обязан совпадать внутри и снаружи контейнера, иначе относительные
пути в `docker-compose.yml` (build-контексты, volume-мапинги) резолвятся неверно.
