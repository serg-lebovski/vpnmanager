// ENGINEER — не привязан ни к одной организации (как SUPER_ADMIN, см. user.organizationId в
// users.service.ts), но урезан по сравнению с ним: может создавать peers для ЛЮБОЙ
// организации/моста, видеть дашборд и создавать/настраивать мосты (см. PeersService,
// BridgesController, DashboardController) — но не может управлять серверами, клиентами
// (организациями), пользователями, настройками панели и удалять мосты. Задуман для
// сотрудников, которые физически разворачивают VPN клиентам, но не администрируют саму
// панель. Список прав сознательно минимален на старте — см. CLAUDE.md.
export enum Role {
  SUPER_ADMIN = 'super_admin',
  ORG_ADMIN = 'org_admin',
  ORG_USER = 'org_user',
  ENGINEER = 'engineer',
}

export enum VpnProtocol {
  WIREGUARD = 'wireguard',
  AMNEZIAWG = 'amneziawg',
}

export enum ServerStatus {
  UNKNOWN = 'unknown',
  ONLINE = 'online',
  OFFLINE = 'offline',
}

export enum ServerProtocolStatus {
  NOT_INSTALLED = 'not_installed',
  INSTALLING = 'installing',
  ACTIVE = 'active',
  ERROR = 'error',
}

export enum PeerSource {
  CREATED = 'created',
  IMPORTED = 'imported',
  // Системный upstream-peer моста на backend-сервере — не показывается в обычных списках
  // peers клиентов, управляется только BridgesService.
  BRIDGE_UPSTREAM = 'bridge_upstream',
}

export enum PeerStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
}

export enum SshAuthType {
  PASSWORD = 'password',
  PRIVATE_KEY = 'private_key',
}

export enum BridgeUpstreamMode {
  MANUAL = 'manual',
  AUTO = 'auto',
  // По доступности: постоянно проверяет TCP-доступность SSH-порта кандидатов из
  // bridge_upstream_candidates (см. BridgeFailoverService) и держит upstream на первом
  // доступном по приоритету — включая автоматический возврат на основной, когда он снова
  // станет доступен. Взаимоисключающий с AUTO на одном мосту (оба дёргают setUpstream по
  // интервалу) — валидируется в BridgesService.setMode.
  FAILOVER = 'failover',
}

export enum BridgeStatus {
  NOT_CONFIGURED = 'not_configured',
  CONFIGURING = 'configuring',
  ACTIVE = 'active',
  ERROR = 'error',
}

// Заявка на самостоятельную регистрацию через Telegram-бота (см. telegram-bot/) — до
// подтверждения суперадмином бот не выдаёт peers (ИНН публично известен через ЕГРЮЛ, сам
// по себе не доказывает, что пишет сотрудник именно этой организации).
export enum TelegramRegistrationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
}

// Только для peers, созданных через Telegram-бота (см. Peer.deviceType) — бот выдаёт не
// больше одного peer на тип устройства, "перевыпуск" снимает старый и создаёт новый того
// же типа.
export enum PeerDeviceType {
  PHONE = 'phone',
  PC = 'pc',
}

// Уровень записи в журнале действий Telegram-бота (TelegramBotLog) — отдельный от
// AuditLogEntry журнал: у бота нет request.user/HTTP-запроса, через который работает
// AuditLogInterceptor, и события другие по смыслу (заявки/выдача peers, а не HTTP-вызовы).
export enum TelegramBotLogLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

// Новости (растущая лента, последние сверху в панели/снизу в чате) и инструкции
// (немного статичных карточек — Windows/iPhone/Android и т.п., отправляются боту целиком) —
// одинаковая форма контента (заголовок+текст+картинки, см. TelegramContentPost), разное
// назначение и разная кнопка в меню бота.
export enum TelegramContentKind {
  NEWS = 'news',
  INSTRUCTION = 'instruction',
}
