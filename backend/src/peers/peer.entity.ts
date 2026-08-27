import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { PeerDeviceType, PeerSource, PeerStatus } from '../common/enums';
import { Organization } from '../organizations/organization.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { TelegramRegistration } from '../telegram-bot/telegram-registration.entity';

// Индексы ниже — Postgres НЕ создаёт их автоматически для FK-колонок (в отличие от PK).
// serverProtocolId фильтруется в каждом syncServerPeers/pickServerProtocol; status+expiresAt
// — в checkExpiredPeers раз в минуту независимо от объёма данных; organizationId/
// createdByUserId — в org-scoping выдачи peers (PeersService.findAllForRequester).
@Entity('peers')
@Index(['serverProtocolId'])
@Index(['status', 'expiresAt'])
@Index(['organizationId'])
@Index(['createdByUserId'])
@Index(['telegramRegistrationId'])
export class Peer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Organization, (organization) => organization.peers, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => ServerProtocol, (serverProtocol) => serverProtocol.peers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_protocol_id' })
  serverProtocol: ServerProtocol;

  @Column({ name: 'server_protocol_id' })
  serverProtocolId: string;

  @Column()
  name: string;

  @Column({ name: 'public_key' })
  publicKey: string;

  @Column({ name: 'private_key_enc', type: 'text', nullable: true })
  privateKeyEnc: string | null;

  @Column({ name: 'preshared_key_enc', type: 'text', nullable: true })
  presharedKeyEnc: string | null;

  @Column({ name: 'allowed_ip' })
  allowedIp: string;

  @Column({ default: '1.1.1.1' })
  dns: string;

  @Column({ type: 'enum', enum: PeerSource, default: PeerSource.CREATED })
  source: PeerSource;

  @Column({ type: 'enum', enum: PeerStatus, default: PeerStatus.ACTIVE })
  status: PeerStatus;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  // "Подписка" без оплат: null — бессрочно (по умолчанию, как раньше). Если задано и
  // срок прошёл — peer НЕ удаляется и не отзывается (status остаётся ACTIVE), просто
  // перестаёт попадать в конфиг, применяемый на сервере (см. PeersService.syncServerPeers) —
  // то есть просто перестаёт давать интернет. Управляет только SUPER_ADMIN (см.
  // PeersService.update).
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  // Заполняются только для peers, выданных через Telegram-бота (см. telegram-bot/) — null
  // для всех остальных (created вручную/через API, imported, bridge upstream). Наличие
  // telegramRegistrationId само по себе уже маркирует "создан через бота", отдельного
  // PeerSource для этого не заводили.
  @ManyToOne(() => TelegramRegistration, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'telegram_registration_id' })
  telegramRegistration: TelegramRegistration | null;

  @Column({ name: 'telegram_registration_id', type: 'uuid', nullable: true })
  telegramRegistrationId: string | null;

  @Column({ name: 'device_type', type: 'enum', enum: PeerDeviceType, nullable: true })
  deviceType: PeerDeviceType | null;

  // Заполняется только для «мульти-конфига» (см. PeersService.createMultiProtocol) — два
  // реальных Peer (свои ключи/IP/интерфейс на каждый протокол, WG и AmneziaWG не могут
  // делить один и тот же ServerProtocol), указывающих друг на друга. Панель обращается с
  // ними как с одним логическим peer'ом: revoke/purge/переименование/срок действия,
  // применённые к одному, каскадом применяются и к другому (см. PeersService.revoke/
  // purge/update). null — обычный одно-протокольный peer.
  @Column({ name: 'paired_peer_id', type: 'uuid', nullable: true })
  pairedPeerId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
