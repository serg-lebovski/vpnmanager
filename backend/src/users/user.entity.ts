import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from '../common/enums';
import { Organization } from '../organizations/organization.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'enum', enum: Role, default: Role.ORG_USER })
  role: Role;

  @ManyToOne(() => Organization, (organization) => organization.users, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  // Защита от подбора пароля (см. AuthService.login) — считает подряд идущие неудачные
  // попытки, сбрасывается в 0 при успешном входе. lockedUntil выставляется при достижении
  // порога и снимается сам по себе по истечении времени (не требует отдельного джоба).
  @Column({ name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  // Инвалидирует ВСЕ выданные ранее refresh-токены разом (сравнивается со значением tv в
  // payload токена, см. AuthService.issueTokens/refresh) — бампается при смене пароля и по
  // явному "выйти со всех устройств". Без этого поля refresh-токены полностью stateless и
  // отозвать украденный токен раньше его естественного истечения (JWT_REFRESH_TTL, по
  // умолчанию 7 дней) было нечем.
  @Column({ name: 'token_version', default: 0 })
  tokenVersion: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
