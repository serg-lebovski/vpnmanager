import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Bridge } from './bridge.entity';

// Приоритетный список upstream-кандидатов моста для режима FAILOVER (см.
// BridgeUpstreamMode.FAILOVER, BridgeFailoverService). priority=0 — основной сервер,
// 1..n — резервы по порядку предпочтения. Join-таблица, а не array-колонка — FK с
// ON DELETE CASCADE подчищает строки сами при удалении Server/ServerProtocol, той же
// идиомой, что и везде в этой схеме; array-колонка такого не даёт и требовала бы ручной
// чистки в ServersService.remove.
@Entity('bridge_upstream_candidates')
export class BridgeUpstreamCandidate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Bridge, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bridge_id' })
  bridge: Bridge;

  @Column({ name: 'bridge_id', type: 'uuid' })
  bridgeId: string;

  @ManyToOne(() => ServerProtocol, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_protocol_id' })
  serverProtocol: ServerProtocol;

  @Column({ name: 'server_protocol_id', type: 'uuid' })
  serverProtocolId: string;

  @Column({ type: 'int' })
  priority: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
