import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Server } from './server.entity';
import { Peer } from '../peers/peer.entity';

@Entity('server_protocols')
export class ServerProtocol {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Server, (server) => server.protocols, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_id' })
  server: Server;

  @Column({ name: 'server_id' })
  serverId: string;

  @Column({ type: 'enum', enum: VpnProtocol })
  protocol: VpnProtocol;

  @Column({ name: 'interface_name' })
  interfaceName: string;

  @Column({ name: 'listen_port' })
  listenPort: number;

  @Column({ name: 'network_cidr' })
  networkCidr: string;

  @Column({ name: 'next_host_octet', default: 2 })
  nextHostOctet: number;

  @Column({ name: 'server_public_key', type: 'varchar', nullable: true })
  serverPublicKey: string | null;

  @Column({ type: 'enum', enum: ServerProtocolStatus, default: ServerProtocolStatus.NOT_INSTALLED })
  status: ServerProtocolStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  // Параметры обфускации AmneziaWG (Jc/Jmin/Jmax/S1/S2/H1-H4, а в AmneziaWG 2.0 ещё и
  // S3/S4, H1-H4 могут быть диапазонами "min-max") — храним значения как есть (число или
  // строка), для обычного WireGuard остаются null.
  @Column({ name: 'obfuscation_params', type: 'jsonb', nullable: true })
  obfuscationParams: Record<string, number | string> | null;

  // Если протокол работает внутри Docker-контейнера (например, официальный self-hosted
  // сервер AmneziaVPN разворачивает протоколы как контейнеры amnezia-*), тут — имя
  // контейнера, команды на сервере выполняются через `docker exec`. null — команды идут
  // напрямую на хосте (наша собственная установка через install()).
  @Column({ name: 'exec_container', type: 'varchar', nullable: true })
  execContainer: string | null;

  // Реальная директория с конфигом на сервере/в контейнере, если она отличается от
  // стандартной для драйвера (актуально для найденных, а не установленных нами
  // протоколов). null — использовать путь по умолчанию для протокола.
  @Column({ name: 'remote_conf_dir', type: 'varchar', nullable: true })
  remoteConfDir: string | null;

  // Исходное значение строки "Address = ..." для найденных (не установленных нами)
  // протоколов — некоторые инсталляции (например, official self-hosted сервер AmneziaVPN)
  // используют нестандартный адрес интерфейса (например, сетевой адрес ".0" вместо ".1").
  // null — использовать наше стандартное значение (gatewayAddress(networkCidr)).
  @Column({ name: 'remote_interface_address', type: 'varchar', nullable: true })
  remoteInterfaceAddress: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Peer, (peer) => peer.serverProtocol)
  peers: Peer[];
}
