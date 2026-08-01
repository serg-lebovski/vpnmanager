import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ServerStatus, SshAuthType } from '../common/enums';
import { ServerProtocol } from './server-protocol.entity';

@Entity('servers')
export class Server {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  host: string;

  @Column({ name: 'ssh_port', default: 22 })
  sshPort: number;

  @Column({ name: 'ssh_username' })
  sshUsername: string;

  @Column({ name: 'ssh_auth_type', type: 'enum', enum: SshAuthType })
  sshAuthType: SshAuthType;

  @Column({ name: 'ssh_secret_enc', type: 'text' })
  sshSecretEnc: string;

  @Column({ type: 'enum', enum: ServerStatus, default: ServerStatus.UNKNOWN })
  status: ServerStatus;

  @Column({ name: 'max_peers', default: 100 })
  maxPeers: number;

  // true — это не сторонний VPS клиента, а хост, на котором крутится сама панель
  // (используется для режима моста: локальный WireGuard-интерфейс для клиентов моста
  // ставится именно на такой Server). Такие серверы UI помечает отдельно.
  @Column({ name: 'is_self', default: false })
  isSelf: boolean;

  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => ServerProtocol, (protocol) => protocol.server)
  protocols: ServerProtocol[];
}
