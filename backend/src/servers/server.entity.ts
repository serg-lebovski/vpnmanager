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

  // Имя профиля, которое видит клиент в официальном приложении AmneziaVPN при импорте
  // .vpn-конфига (поле "description" в формате приложения, см. peers/amnezia-config.util.ts)
  // — НЕ то же самое, что `name` (внутреннее имя сервера в панели). null — по умолчанию
  // используется `name`; без этого поля туда попадало имя peer'а (например, ФИО клиента,
  // выданное через Telegram-бота/портал) — рабочий, но неподходящий для отображения текст.
  @Column({ name: 'amnezia_app_name', type: 'varchar', nullable: true })
  amneziaAppName: string | null;

  // true — это не сторонний VPS клиента, а хост, на котором крутится сама панель
  // (используется для режима моста: локальный WireGuard-интерфейс для клиентов моста
  // ставится именно на такой Server). Такие серверы UI помечает отдельно.
  @Column({ name: 'is_self', default: false })
  isSelf: boolean;

  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  // TOFU (trust-on-first-use) — отпечаток SSH host key, зафиксированный при первом
  // успешном подключении (см. SshService). null — ещё не подключались ни разу, либо
  // отпечаток сброшен вручную (после осознанной переустановки ОС сервера/смены хоста —
  // PATCH /servers/:id/reset-host-key). Несовпадение при следующем подключении — сигнал
  // возможной подмены сервера/MITM, подключение отклоняется (см. SshService.exec).
  @Column({ name: 'ssh_host_key_fingerprint', type: 'varchar', nullable: true })
  sshHostKeyFingerprint: string | null;

  // Постоянный MTProto-proxy (обход блокировки Telegram у клиентов) — устанавливается
  // кнопкой на карточке self-сервера (см. MtProxyService), не путать со старой версией
  // (временная сессия на 10 минут по запросу с портала, от которой отказались 2026-08-15).
  // mtProxyPort меняется только при установке/переустановке, mtProxySecretEnc — ещё и раз в
  // сутки автоматической ротацией (MtProxyService.rotateSecrets), без переустановки порта.
  @Column({ name: 'mtproxy_port', type: 'int', nullable: true })
  mtProxyPort: number | null;

  @Column({ name: 'mtproxy_secret_enc', type: 'text', nullable: true })
  mtProxySecretEnc: string | null;

  @Column({ name: 'mtproxy_updated_at', type: 'timestamptz', nullable: true })
  mtProxyUpdatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => ServerProtocol, (protocol) => protocol.server)
  protocols: ServerProtocol[];
}
