import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BridgeStatus, BridgeUpstreamMode } from '../common/enums';
import { Organization } from '../organizations/organization.entity';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { BridgeUpstreamCandidate } from './bridge-upstream-candidate.entity';

@Entity('bridges')
export class Bridge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  // Организация, для которой этот мост — null означает общий/суперадминский мост
  // (виден и назначается только суперадмином).
  @ManyToOne(() => Organization, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  // Локальные интерфейсы на self-сервере, к которым подключаются клиенты моста —
  // независимые FK на WireGuard и AmneziaWG (обычный ServerProtocol, как у любого
  // другого сервера). Хотя бы один обязателен (валидируется на уровне сервиса), оба
  // могут быть заданы одновременно — мост тогда выдаёт peers по обоим протоколам,
  // и оба маршрутизируются через один и тот же upstream.
  @ManyToOne(() => ServerProtocol, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wireguard_client_protocol_id' })
  wireguardClientProtocol: ServerProtocol | null;

  @Column({ name: 'wireguard_client_protocol_id', type: 'uuid', nullable: true })
  wireguardClientProtocolId: string | null;

  @ManyToOne(() => ServerProtocol, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'amneziawg_client_protocol_id' })
  amneziawgClientProtocol: ServerProtocol | null;

  @Column({ name: 'amneziawg_client_protocol_id', type: 'uuid', nullable: true })
  amneziawgClientProtocolId: string | null;

  @Column({ name: 'upstream_mode', type: 'enum', enum: BridgeUpstreamMode, default: BridgeUpstreamMode.MANUAL })
  upstreamMode: BridgeUpstreamMode;

  // Backend-сервер (уже добавленный в систему), через который мост сейчас маршрутизирует
  // трафик своих клиентов.
  @ManyToOne(() => ServerProtocol, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'upstream_server_protocol_id' })
  upstreamServerProtocol: ServerProtocol | null;

  @Column({ name: 'upstream_server_protocol_id', type: 'uuid', nullable: true })
  upstreamServerProtocolId: string | null;

  // Системный peer моста на upstream-сервере (source=BRIDGE_UPSTREAM) — общий туннель,
  // через который NAT'ятся все клиенты моста.
  @ManyToOne(() => Peer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'upstream_peer_id' })
  upstreamPeer: Peer | null;

  @Column({ name: 'upstream_peer_id', type: 'uuid', nullable: true })
  upstreamPeerId: string | null;

  // Имя WG-интерфейса на self-сервере, которым мост подключается К upstream-серверу
  // (в отличие от клиентских интерфейсов выше — это интерфейс к upstream). Генерируется
  // случайным при создании (не константа!) — на одном self-сервере может быть несколько
  // мостов, и у каждого должен быть свой upstream-интерфейс, иначе они начнут управлять
  // одним и тем же netdev друг у друга.
  @Column({ name: 'upstream_interface_name' })
  upstreamInterfaceName: string;

  // Отдельная таблица маршрутизации Linux для этого моста (см. connectAsClient/
  // setupBridgeNat в vpn-provisioning.service.ts) — у каждого моста своя, иначе два
  // моста на одном self-сервере перезаписывали бы маршруты друг друга. Выделяется при
  // создании как MAX(routeTable)+1 по всем мостам (см. bridges.service.ts) — приложение
  // всегда проставляет реальное значение явно при create(); default здесь только чтобы
  // synchronize:true не упал при добавлении NOT NULL колонки на непустую таблицу bridges
  // (у уже существующих мостов после деплоя окажется 52000 — ровно то, что получил бы
  // самый первый мост и через обычный allocateRouteTable()).
  @Column({ name: 'route_table', type: 'int', default: 52000 })
  routeTable: number;

  @Column({ type: 'enum', enum: BridgeStatus, default: BridgeStatus.NOT_CONFIGURED })
  status: BridgeStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  // Если задано — клиентские конфиги, скачанные через peers этого моста, используют этот
  // домен в Endpoint вместо IP self-сервера (см. PeersService.getDownloadableConfig).
  // Нужно для disaster recovery: self-сервер можно переехать на новый хост/IP, просто
  // переставив DNS-запись, без необходимости раздавать все клиентские конфиги заново.
  @Column({ name: 'domain_name', type: 'varchar', nullable: true })
  domainName: string | null;

  // Приоритетный список кандидатов для режима FAILOVER (см. BridgeUpstreamMode.FAILOVER,
  // BridgeFailoverService) — независим от upstreamServerProtocolId ("что активно прямо
  // сейчас"), это "в каком порядке предпочитать".
  @OneToMany(() => BridgeUpstreamCandidate, (candidate) => candidate.bridge)
  upstreamCandidates: BridgeUpstreamCandidate[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
