import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';
import { Peer } from '../peers/peer.entity';

@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  // Какие обычные (не self-) серверы эта организация может выбрать НАПРЯМУЮ при создании
  // peer'а — allow-list, по умолчанию пусто (доступа нет вообще, только через мост, см.
  // PeersService — прямой выбор сервера обходит мост, это более "привилегированный"
  // вариант, выдаётся явно, не по умолчанию).
  @Column({ name: 'allowed_server_ids', type: 'uuid', array: true, default: () => "'{}'" })
  allowedServerIds: string[];

  // Какие мосты НЕДОСТУПНЫ этой организации — block-list, по умолчанию пусто (доступны
  // ВСЕ мосты, видимые организации по обычному правилу видимости — общие + свои, см.
  // PeersService.findBridgeClientProtocol). Именно block-, а не allow-list — иначе
  // добавление НОВОГО моста в будущем требовало бы вручную включать его каждой
  // организации; так по умолчанию доступны все, суперадмин явно забирает доступ.
  @Column({ name: 'blocked_bridge_ids', type: 'uuid', array: true, default: () => "'{}'" })
  blockedBridgeIds: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => User, (user) => user.organization)
  users: User[];

  @OneToMany(() => Peer, (peer) => peer.organization)
  peers: Peer[];
}
