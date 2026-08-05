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

**Срок действия peer'а** (`Peer.expiresAt`, nullable — "подписка" без интеграции с оплатами) —
управляет только `SUPER_ADMIN` (`PeersService.update`, `org_admin`/`org_user` поле не видят и не
меняют). Когда срок проходит, peer НЕ отзывается и НЕ удаляется (`status` остаётся `ACTIVE`,
конфиг остаётся скачиваемым) — он просто перестаёт попадать в выборку `syncServerPeers` (условие
`expiresAt IS NULL OR expiresAt > now`), а значит не применяется в `wg`/`awg`-конфиге на сервере при
следующей синхронизации — то есть просто перестаёт давать интернет. Поскольку истечение срока — это
точка во времени, а не событие, и может не совпасть ни с одним другим действием над этим же
`ServerProtocol` (revoke/create/update другого peer, которые и так вызывают `syncServerPeers`),
`PeersService.checkExpiredPeers` (`@Interval`, раз в минуту) сам находит свежеистёкшие peers и
досинхронизирует их протоколы; `appliedExpiry` (peerId → `expiresAt.getTime()`, in-memory) не даёт
пересинхронизировать один и тот же протокол на каждый тик, пока peer остаётся в истёкшем состоянии,
но корректно реагирует на повторное истечение после продления (новое значение `expiresAt` не
совпадает с уже обработанным).

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
добавленных backend-серверов через `VpnDriver.connectAsClient`. Self-сервер не выбирается из списка
при создании моста — `BridgesService.create` сам ищет существующий `Server` с `isSelf = true` и
переиспользует его; если такого ещё нет (самый первый мост в системе), фронтенд запрашивает
SSH-доступ к хосту прямо в форме создания моста (`CreateBridgeDto.selfServerCredentials`) и сервис
сам создаёт для него `Server` (`name: 'Этот сервер'`, `isSelf: true`) — отдельно ходить на вкладку
«Серверы» и добавлять свой же хост вручную не нужно. Один self-сервер может нести
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
Self-серверы **не** скрыты из списка «Серверы (VPS)» на фронтенде (раньше были скрыты через
`Server.isSelf`, но от этого отказались — сервер всегда виден, только конкретные протоколы,
занятые мостом, помечаются чипом «мост «Имя»» в `ServersPage.tsx`). Удаление backend-сервера
сначала вызывает `BridgesService.reassignUpstreamAwayFrom` (переключает зависящие от него мосты
на другой ACTIVE сервер того же протокола, best-effort по каждому мосту), иначе после
`ON DELETE SET NULL` мост завис бы без upstream без возможности починки кроме как вручную;
удаление самого моста (`BridgesService.remove`) отзывает и удаляет (не только отзывает) системный
upstream-peer и удаляет клиентские `ServerProtocol` моста.

**Доменное имя моста** (`Bridge.domainName`, nullable) — если задано, `PeersService.
getDownloadableConfig` подставляет его вместо `server.host` в `Endpoint =` генерируемого
клиентского конфига (копия существующего запроса ServerProtocol→Bridge из
`findActiveServerProtocolByServer`, `config-generator.util.ts` не меняется — использует из
переданного объекта только `.host`). Не путать с доменом самой панели (`system/settings.
service.ts`, см. ниже) — это про VPN-эндпоинт клиентов моста, задаётся ради disaster recovery:
self-сервер можно перенести на другой хост/IP, просто переставив DNS, без переустановки уже
выданных клиентских конфигов.

**Failover upstream** (`BridgeUpstreamMode.FAILOVER`, `bridge-failover.service.ts`,
`bridge-upstream-candidate.entity.ts`) — альтернатива load-based `AUTO`: приоритетный список
кандидатов (`bridge_upstream_candidates`, join-таблица `bridgeId`+`serverProtocolId`+`priority`,
0 = основной; `ON DELETE CASCADE` на обе FK, отдельно чистить при удалении Server/ServerProtocol
не нужно) вместо одного заранее выбранного upstream. `AUTO` и `FAILOVER` — значения одного и
того же поля `upstreamMode`, взаимоисключающие (оба дёргают `setUpstream` из своего интервала,
одновременно на одном мосту работать не должны); `BridgesService.setMode` требует хотя бы
одного кандидата для входа в `FAILOVER`. Отдельный сервис `BridgeFailoverService` (не метод
`BridgesService` — своё приватное mutable-состояние per-server, зависимость только в одну
сторону: `BridgeFailoverService` → `BridgesService.setUpstream`, без обратной, иначе DI-цикл)
каждые 20с (`FAILOVER_CHECK_INTERVAL_MS`) TCP-пингует (`common/tcp-probe.util.ts#probeTcpPort`,
обычный `net.Socket`, без новых зависимостей) SSH-порт каждого физического сервера-кандидата
(дедуплицированного по `serverId`, не по кандидату — один сервер может быть кандидатом сразу у
нескольких мостов) — **не** VPN-порт: WireGuard/AmneziaWG на UDP и намеренно не отвечают на
произвольные пакеты (анти-фингерпринтинг), так что TCP-пинг VPN-порта был бы бессмысленным.
Флап-защита (`FLAP_PROTECTION_CONSECUTIVE = 3`): сервер меняет статус доступности только после
3 подряд одинаковых результатов проверки, и в первые проверки после старта/включения режима
статус остаётся `null` (неизвестно), а не сразу "недоступен". На каждый тик — для каждого моста
в режиме `FAILOVER` берётся первый ДОСТУПНЫЙ кандидат по приоритету; если он отличается от
текущего активного upstream и мост не в `CONFIGURING` — вызывается `setUpstream` (та же функция,
что и ручное/AUTO-переключение, весь NAT/peer/progress-код переиспользуется как есть). Если ни
один кандидат не доступен — активный upstream не трогается (лучше рабочий, чем никакой).
`GET /bridges/:id/candidate-status` (снимок доступности по serverId) собирается на уровне
контроллера, не сервиса — тоже чтобы не создавать DI-цикл.

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

**Рабочий процесс деплоя**: Claude коммитит и пушит изменения в `origin/main` на GitHub — и
на этом останавливается. Обновление продакшен-сервера (`git pull` + `docker compose up -d
--build`) пользователь делает сам вручную по SSH; не пытайся подключаться к серверу или
запускать деплой самостоятельно, если явно не попросили именно в этот раз.

`docker-compose.yml` поднимает 4 сервиса: `postgres`, `backend` (build из `backend/Dockerfile`),
`frontend` (build из `frontend/Dockerfile`, отдаёт статику), `nginx` (единственный сервис с внешними
портами 80/443). `nginx` монтирует не статический файл, а целую директорию `nginx/generated`
(`:ro`) — см. ниже про `NginxConfigService`. `backend` ждёт `postgres` healthy (`pg_isready`) через
`depends_on.condition: service_healthy`.

Известные эксплуатационные ограничения (подробности и причины — в README.md, раздел «Известные
ограничения MVP»): поддерживаются только сети `a.b.c.0/24`; установка AmneziaWG зависит от внешнего
PPA и может не собраться под конкретное ядро/дистрибутив; self-сервер моста в непривилегированном
LXC-контейнере не может поднять реальный WireGuard-интерфейс.

**Домен + HTTPS панели** (`system/settings.service.ts`, `certbot.service.ts`,
`nginx-config.service.ts`) — вкладка «Настройки» → «Домен и HTTPS», не путать с
`Bridge.domainName` (это про VPN-эндпоинт клиентов моста, а не про веб-UI/API панели).
`nginx/nginx.conf.template` (git-tracked, общие `/api/`/`/socket.io/`/`/` локации) —
единственное место, где редактировать сами локации; `NginxConfigService.render()` собирает
из него `nginx/generated/default.conf` (тоже git-tracked — закоммичен ОДИН РАЗ с безопасным
HTTP-only дефолтом для чистой установки и **больше никогда не должен трогаться коммитами** —
backend перезаписывает этот файл на диске при каждом старте/изменении настроек, и если бы git
тоже его менял, `git pull` при самообновлении конфликтовал бы с локально сгенерированной
версией) в зависимости от `SystemSettings` (домен/HTTP/HTTPS/срок сертификата) и перезагружает
nginx через `docker exec <container> nginx -t && nginx -s reload` (`common/docker.util.ts`,
резолвит id контейнера по label `com.docker.compose.service`, не по имени — обычный `docker
exec`, а не sibling-container: это не self-recreation, в отличие от `update.service.ts`).
Сертификат Let's Encrypt выпускает `certbot`, запущенный обычным child-process ПРЯМО в
backend-контейнере (HTTP-01 webroot, без нужды в root/эксклюзивном порту) — КРИТИЧНО:
`--config-dir`/`--work-dir`/`--logs-dir` явно указывают на `${REPO_PATH}/certbot/...` (а не
дефолтный `/etc/letsencrypt` внутри backend-контейнера, невидимый для nginx), тот же путь
смонтирован в nginx read-only. `${REPO_PATH}/certbot/` — в `.gitignore` (приватные ключи).
Инвариант безопасности: слушать 443 начинаем, только если файл сертификата реально существует
на диске, независимо от `httpsEnabled` в БД; включение HTTPS без домена+email или при неудачном
выпуске не ломает доступность панели по HTTP. Автообновление — суточный `@Cron` (`certbot renew`,
самостоятельно no-op, если сертификату ещё не пора).

**Резервное копирование/восстановление данных** (`backup.service.ts`/`restore.service.ts`) —
только данные (дамп `pg_dump`), не сам проект: для disaster recovery на новом сервере проект
разворачивается обычным способом, а этот дамп загружается как конфигурация; вместе с
`Bridge.domainName` (см. bridges/) это позволяет старым peers снова заработать после смены
IP — достаточно перевести DNS. `pg_dump` в `backup.service.ts` — БЕЗ `--clean`/`--if-exists`,
поэтому `RestoreService` перед `psql -f <дамп>` обязательно обрывает текущие соединения
приложения (`pg_terminate_backend`) и делает `DROP SCHEMA public CASCADE; CREATE SCHEMA
public;` — иначе `psql` упал бы на первом же `CREATE TABLE` против непустой схемы.
Восстановление необратимо стирает текущую БД — `POST /system/restore` требует точную фразу-
подтверждение (`RESTORE_CONFIRMATION_PHRASE`), проверяемую на сервере, не только диалогом на
фронте. После успешного восстановления процесс завершает себя (`process.exit()`, НЕ через
sibling-container из `update.service.ts` — тут не меняются ни образ, ни identity контейнера,
обычного `restart: unless-stopped` достаточно для чистого рестарта). `Server.sshSecretEnc`
зашифрован ключом `APP_ENCRYPTION_KEY` ТЕКУЩЕГО деплоя — на другом сервере с другим ключом он
не расшифруется; `ServersService.findAll()` вычисляет `needsCredentials` при каждом чтении
(пробует `decryptSecret`), `PATCH /servers/:id/credentials` — узкий эндпоинт для переввода.
Программного переноса самого ключа шифрования между деплоями нет — осознанное решение
(бэкап-файл и ключ шифрования нарочно остаются раздельными секретами).

**Модуль `system/`** (бэкенд, `@Roles(SUPER_ADMIN)`) — вкладка «Настройки»: `backup.service.ts`
стримит `pg_dump` прямо в HTTP-ответ; `update.service.ts` запускает `git pull` +
пересборку/пересоздание контейнеров изнутри backend-контейнера через смонтированный
`/var/run/docker.sock` хоста (Docker-outside-of-Docker, root-эквивалент — осознанный компромисс,
подробности и как отключить — в README.md, раздел «Настройки сервера»). `REPO_PATH` в
`docker-compose.yml` (`${PWD}`) обязан совпадать внутри и снаружи контейнера, иначе относительные
пути в `docker-compose.yml` (build-контексты, volume-мапинги) резолвятся неверно. nginx и frontend
пересоздаются с `--force-recreate`: без него сервис с неизменившимся образом (у нас так `nginx`) не
пересоздаётся, даже если поменялся смонтированный ОТДЕЛЬНЫЙ ФАЙЛ конфига (изначально —
`nginx/nginx.conf`, сейчас на его месте генерируемый `nginx/generated/default.conf`, см. ниже) —
`git pull` заменяет файл новым inode, а bind-mount уже запущенного контейнера продолжает указывать
на старый (поймано вживую при первом деплое этой фичи 2026-08-03). Финальный шаг — пересоздание
самого backend — **не** выполняется обычным дочерним процессом backend'а: `docker compose up -d
--no-deps backend`, запущенный как прямой child текущего процесса, гарантированно обрывается вместе
со всем контейнером в момент, когда демон останавливает старый backend (это первый шаг той же
последовательности stop→rm→create→start, которую этот же процесс и вёл) — итог: старый контейнер
удалён, а новый создать уже некому, backend зависает недоступным до ручного `docker compose up -d`
по SSH (пойманный вживую повторный инцидент, 2026-08-04). Поэтому `recreateBackendDetached`
запускает этот шаг в независимом sibling-контейнере (`docker run -d --rm <тот же self-образ> sh -c
"sleep 2 && docker compose up -d --no-deps backend"`) — он не входит в cgroup/pid namespace
backend'а, и его никак не касается убийство backend-контейнера. Фронтенд параллельно поллит
публичный (без auth) `GET /health` (`app.controller.ts`) через `BackendStatusBanner` — глобальный
баннер «backend недоступен», смонтированный в `App.tsx` над роутами, виден на любой странице
включая `/login`.
