import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Единственная строка настроек панели (id всегда 1) — домен/HTTPS для самой панели (не
// путать с Bridge.domainName, который про VPN-эндпоинт клиентов, а не про веб-UI/API).
// SettingsService.getOrCreate() гарантирует существование этой строки.
@Entity('system_settings')
export class SystemSettings {
  @PrimaryColumn({ default: 1 })
  id: number;

  @Column({ nullable: true })
  domain: string | null;

  @Column({ name: 'lets_encrypt_email', nullable: true })
  letsEncryptEmail: string | null;

  @Column({ name: 'http_enabled', default: true })
  httpEnabled: boolean;

  @Column({ name: 'https_enabled', default: false })
  httpsEnabled: boolean;

  @Column({ name: 'cert_expires_at', type: 'timestamptz', nullable: true })
  certExpiresAt: Date | null;

  @Column({ name: 'last_cert_error', type: 'text', nullable: true })
  lastCertError: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
