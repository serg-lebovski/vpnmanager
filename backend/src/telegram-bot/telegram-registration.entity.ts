import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TelegramRegistrationStatus } from '../common/enums';
import { Organization } from '../organizations/organization.entity';

// Заявка на самостоятельную регистрацию сотрудника клиентской организации — через Telegram-
// бота (см. telegram-bot.service.ts) ИЛИ через публичный веб-портал (telegram-portal.
// service.ts, для клиентов без доступа к Telegram) — сопоставляется с Organization по
// названию+ИНН, затем ждёт ручного подтверждения суперадминистратором (см.
// TelegramRegistrationStatus). Не User: у этого контакта нет пароля/роли/входа в панель.
@Entity('telegram_registrations')
@Index(['status'])
@Index(['organizationId'])
export class TelegramRegistration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Строкой, а не числом — id чата в Telegram может выходить за пределы безопасного
  // диапазона чисел JS (Number.MAX_SAFE_INTEGER), тот же подход, что и у
  // SystemSettings.telegramChatId. Nullable — заявка, заведённая через веб-портал, ещё не
  // привязана ни к одному Telegram-чату (см. webToken/TelegramBotService.handleStart).
  @Column({ name: 'telegram_chat_id', type: 'varchar', unique: true, nullable: true })
  telegramChatId: string | null;

  // Бессрочный bearer-токен персональной ссылки веб-портала (`/portal/<token>`) — не
  // секрет уровня пароля (клиент и так видит эту ссылку в открытом виде), но неугадываемый
  // (crypto-случайный UUID) и достаточен как единственная защита публичных
  // /telegram-portal/*-эндпоинтов. Nullable по историческим причинам (у заявок, заведённых
  // до появления портала, токена изначально нет) — TelegramRegistrationsService.
  // getPortalLink генерирует его лениво по первому запросу админа. Заявки, заведённые
  // ПОСЛЕ появления портала (и через бота, и через сам портал), получают токен сразу при
  // создании — см. TelegramBotService/TelegramPortalService.
  @Column({ name: 'web_token', type: 'varchar', unique: true, nullable: true })
  webToken: string | null;

  @Column({ name: 'telegram_username', type: 'varchar', nullable: true })
  telegramUsername: string | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'full_name' })
  fullName: string;

  @Column({ type: 'enum', enum: TelegramRegistrationStatus, default: TelegramRegistrationStatus.PENDING })
  status: TelegramRegistrationStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
