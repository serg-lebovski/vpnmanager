import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TelegramRegistrationStatus } from '../common/enums';
import { Organization } from '../organizations/organization.entity';

// Заявка на самостоятельную регистрацию сотрудника клиентской организации через Telegram-
// бота (см. telegram-bot.service.ts) — сопоставляется с Organization по названию+ИНН,
// затем ждёт ручного подтверждения суперадминистратором (см. TelegramRegistrationStatus).
// Не User: у этого контакта нет пароля/роли/входа в панель — только переписка с ботом.
@Entity('telegram_registrations')
@Index(['status'])
@Index(['organizationId'])
export class TelegramRegistration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Строкой, а не числом — id чата в Telegram может выходить за пределы безопасного
  // диапазона чисел JS (Number.MAX_SAFE_INTEGER), тот же подход, что и у
  // SystemSettings.telegramChatId.
  @Column({ name: 'telegram_chat_id', type: 'varchar', unique: true })
  telegramChatId: string;

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
