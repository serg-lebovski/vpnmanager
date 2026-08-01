import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { PeerSource, PeerStatus } from '../common/enums';
import { Organization } from '../organizations/organization.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';

@Entity('peers')
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
