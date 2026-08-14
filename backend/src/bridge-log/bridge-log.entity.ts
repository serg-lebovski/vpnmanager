import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { LogLevel } from '../common/enums';

// Журнал жизненного цикла мостов — переключения upstream (ручные/авто/failover), настройка
// NAT/bypass/маршрутизации Telegram через мост, восстановление после перезагрузки self-
// сервера и т.п. Живёт в БД (не только в docker logs), потому что docker logs пропадают при
// каждом пересоздании контейнера backend (обычное дело при каждом деплое) — пойманный
// вживую инцидент (2026-08-14): именно из-за этого не осталось прямых логов о том, почему
// изначально отвалился upstream. bridgeId/bridgeName — без FK и денормализовано (тот же
// принцип, что у TelegramBotLog.chatId/PeerTrafficSample): мост мог быть с тех пор удалён,
// запись всё равно должна остаться читаемой.
@Entity('bridge_logs')
@Index(['createdAt'])
export class BridgeLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: LogLevel, default: LogLevel.INFO })
  level: LogLevel;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'bridge_id', type: 'uuid', nullable: true })
  bridgeId: string | null;

  @Column({ name: 'bridge_name', type: 'varchar', nullable: true })
  bridgeName: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
