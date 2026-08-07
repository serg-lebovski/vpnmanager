import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Не FK на User — строка должна пережить удаление пользователя (иначе история "кто что
// делал" стиралась бы вместе с уволенным/удалённым админом), поэтому email — снимок на
// момент действия, а не JOIN.
@Entity('audit_log_entries')
@Index(['createdAt'])
export class AuditLogEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId: string | null;

  @Column({ name: 'actor_email', type: 'varchar', nullable: true })
  actorEmail: string | null;

  @Column()
  method: string;

  @Column()
  path: string;

  // request.params.id, если есть — не всегда однозначно указывает на конкретную сущность
  // (иногда это id родителя, не самого объекта действия), но в большинстве маршрутов этого
  // проекта совпадает с целью действия.
  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId: string | null;

  // Тело запроса с вырезанными чувствительными полями (пароли/секреты/приватные ключи —
  // см. AuditLogService.redact) — не сырые данные с фронтенда как есть.
  @Column({ type: 'jsonb', nullable: true })
  body: Record<string, unknown> | null;

  @Column({ name: 'status_code' })
  statusCode: number;

  @Column({ name: 'ip_address', type: 'varchar', nullable: true })
  ipAddress: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
