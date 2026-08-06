import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PeerSource } from '../common/enums';

// Дельты (НЕ кумулятивные счётчики) трафика peer'а за один интервал персистентности (см.
// DashboardService.PERSIST_INTERVAL_MS) — история для отчётов "сколько трафика за
// день/неделю/месяц" на дашборде. Не FK на Peer/Server — строки этой таблицы должны
// пережить удаление peer'а/сервера (иначе история "сколько было" задним числом теряется
// вместе с записью), поэтому все нужные для отображения поля денормализованы (снимок на
// момент замера, а не текущее состояние).
@Entity('peer_traffic_samples')
@Index(['sampledAt'])
@Index(['peerId', 'sampledAt'])
@Index(['serverId', 'sampledAt'])
export class PeerTrafficSample {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'peer_id', type: 'uuid' })
  peerId: string;

  @Column({ name: 'peer_name' })
  peerName: string;

  // BRIDGE_UPSTREAM — системный peer моста (см. common/enums.ts) — несёт суммарный трафик
  // ВСЕХ клиентов моста через upstream-сервер разом; учитывается в разбивке по серверам
  // (это реальный трафик через тот сервер), но исключается из разбивки по peers (не
  // настоящий клиент, и так скрыт из обычных списков peers).
  @Column({ name: 'peer_source', type: 'enum', enum: PeerSource })
  peerSource: PeerSource;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'server_id', type: 'uuid' })
  serverId: string;

  @Column({ name: 'server_name' })
  serverName: string;

  // bigint — счётчики трафика теоретически могут превысить 32-битный int; transformer
  // возвращает обычный JS number (а не строку, как TypeORM делает для bigint по умолчанию)
  // — значения далеко не достигают Number.MAX_SAFE_INTEGER (9 ПБ) на практике, а обычный
  // number сильно упрощает SUM() на чтении.
  @Column({ name: 'rx_bytes', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  rxBytes: number;

  @Column({ name: 'tx_bytes', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  txBytes: number;

  @CreateDateColumn({ name: 'sampled_at' })
  sampledAt: Date;
}
