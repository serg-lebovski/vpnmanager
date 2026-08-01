import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BridgeStatus, BridgeUpstreamMode } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';

@Entity('bridges')
export class Bridge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  // Локальный WireGuard-интерфейс на self-сервере, к которому подключаются клиенты моста.
  @ManyToOne(() => ServerProtocol, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_server_protocol_id' })
  clientServerProtocol: ServerProtocol;

  @Column({ name: 'client_server_protocol_id' })
  clientServerProtocolId: string;

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
  // (в отличие от clientServerProtocol.interfaceName — это интерфейс для клиентов моста).
  @Column({ name: 'upstream_interface_name', default: 'wg-upstream0' })
  upstreamInterfaceName: string;

  @Column({ type: 'enum', enum: BridgeStatus, default: BridgeStatus.NOT_CONFIGURED })
  status: BridgeStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
