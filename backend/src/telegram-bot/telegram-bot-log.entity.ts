import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TelegramBotLogLevel } from '../common/enums';

// Журнал действий Telegram-бота самостоятельной регистрации — видно в панели (вкладка
// Telegram), без необходимости заходить по SSH и смотреть docker logs, чтобы понять, что
// произошло у конкретного пользователя (заявка отправлена/подтверждена, peer выдан/ошибка
// выдачи). Не переиспользует AuditLogEntry — тот журнал строится вокруг HTTP-запросов
// панели (request.user, AuditLogInterceptor), у бота нет ни того, ни другого.
@Entity('telegram_bot_logs')
@Index(['createdAt'])
export class TelegramBotLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: TelegramBotLogLevel, default: TelegramBotLogLevel.INFO })
  level: TelegramBotLogLevel;

  @Column({ type: 'text' })
  message: string;

  // Чей чат/заявка — для контекста в интерфейсе, без FK (регистрация могла уже быть
  // удалена к моменту просмотра лога, запись всё равно должна остаться читаемой).
  @Column({ name: 'chat_id', type: 'varchar', nullable: true })
  chatId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
