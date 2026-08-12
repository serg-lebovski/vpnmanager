import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Единственная строка настроек панели (id всегда 1) — домен/HTTPS для самой панели (не
// путать с Bridge.domainName, который про VPN-эндпоинт клиентов, а не про веб-UI/API).
// SettingsService.getOrCreate() гарантирует существование этой строки.
@Entity('system_settings')
export class SystemSettings {
  @PrimaryColumn({ default: 1 })
  id: number;

  @Column({ type: 'varchar', nullable: true })
  domain: string | null;

  @Column({ name: 'lets_encrypt_email', type: 'varchar', nullable: true })
  letsEncryptEmail: string | null;

  @Column({ name: 'http_enabled', default: true })
  httpEnabled: boolean;

  @Column({ name: 'https_enabled', default: false })
  httpsEnabled: boolean;

  @Column({ name: 'cert_expires_at', type: 'timestamptz', nullable: true })
  certExpiresAt: Date | null;

  @Column({ name: 'last_cert_error', type: 'text', nullable: true })
  lastCertError: string | null;

  @Column({ name: 'telegram_enabled', default: false })
  telegramEnabled: boolean;

  // Зашифрован тем же APP_ENCRYPTION_KEY, что SSH-секреты серверов и ключи peers (см.
  // common/encryption.util.ts) — токен бота даёт полный контроль над ботом.
  @Column({ name: 'telegram_bot_token_enc', type: 'text', nullable: true })
  telegramBotTokenEnc: string | null;

  @Column({ name: 'telegram_chat_id', type: 'varchar', nullable: true })
  telegramChatId: string | null;

  // Если задан — исходящие запросы к Telegram Bot API маршрутизируются через upstream
  // ЭТОГО моста (self-сервер помечает такой трафик меткой и отправляет через туннель) —
  // на случай, если Telegram заблокирован в стране, где расположен сам self-сервер
  // панели. null — обычный прямой исходящий запрос с self-сервера. См.
  // VpnProvisioningService.setupTelegramRouting.
  @Column({ name: 'telegram_bridge_id', type: 'uuid', nullable: true })
  telegramBridgeId: string | null;

  // Первое сообщение, которое видит человек, впервые написавший боту /start, ДО запроса
  // названия организации — редактируется суперадмином (см. TelegramBotPage.tsx). null —
  // TelegramBotService подставляет дефолтный текст сам, а не хранит его тут дважды.
  @Column({ name: 'telegram_welcome_message', type: 'text', nullable: true })
  telegramWelcomeMessage: string | null;

  // Свободный текст, который бот присылает по кнопке "ℹ️ Информация" из главного меню —
  // произвольные инструкции/контакты поддержки и т.п., целиком на усмотрение суперадмина.
  @Column({ name: 'telegram_info_message', type: 'text', nullable: true })
  telegramInfoMessage: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
