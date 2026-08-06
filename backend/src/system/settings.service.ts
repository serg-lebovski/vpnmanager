import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { setCorsAllowedDomain } from '../common/cors-origin.state';
import { CertbotService } from './certbot.service';
import { NginxConfigService } from './nginx-config.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SystemSettings } from './system-settings.entity';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(SystemSettings) private readonly settingsRepository: Repository<SystemSettings>,
    private readonly certbotService: CertbotService,
    private readonly nginxConfigService: NginxConfigService,
  ) {}

  async getOrCreate(): Promise<SystemSettings> {
    const existing = await this.settingsRepository.findOne({ where: { id: 1 } });
    if (existing) {
      return existing;
    }
    return this.settingsRepository.save(this.settingsRepository.create({ id: 1 }));
  }

  async update(dto: UpdateSettingsDto): Promise<SystemSettings> {
    const settings = await this.getOrCreate();

    const nextHttpEnabled = dto.httpEnabled ?? settings.httpEnabled;
    const nextHttpsEnabled = dto.httpsEnabled ?? settings.httpsEnabled;
    if (!nextHttpEnabled && !nextHttpsEnabled) {
      throw new BadRequestException('Нельзя выключить и HTTP, и HTTPS одновременно — панель станет недоступна');
    }

    const domainChanged = dto.domain !== undefined && dto.domain !== settings.domain;
    const emailChanged = dto.letsEncryptEmail !== undefined && dto.letsEncryptEmail !== settings.letsEncryptEmail;
    const turningHttpsOn = nextHttpsEnabled && !settings.httpsEnabled;

    if (dto.domain !== undefined) {
      settings.domain = dto.domain;
    }
    if (dto.letsEncryptEmail !== undefined) {
      settings.letsEncryptEmail = dto.letsEncryptEmail;
    }
    settings.httpEnabled = nextHttpEnabled;

    if (nextHttpsEnabled && (turningHttpsOn || domainChanged || emailChanged)) {
      if (!settings.domain || !settings.letsEncryptEmail) {
        throw new BadRequestException('Для HTTPS нужно указать домен и email для Let\'s Encrypt');
      }
      // Сначала рендерим БЕЗ сертификата (httpsEnabled временно false в рендере) — nginx
      // на 80-м порту должен уже отдавать /.well-known/acme-challenge/ для этого домена
      // ДО того, как придёт HTTP-01 запрос от Let's Encrypt.
      await this.nginxConfigService.render({ domain: settings.domain, httpEnabled: settings.httpEnabled, httpsEnabled: false });
      try {
        await this.certbotService.issue(settings.domain, settings.letsEncryptEmail);
        settings.httpsEnabled = true;
        settings.certExpiresAt = await this.certbotService.readCertExpiry(settings.domain);
        settings.lastCertError = null;
      } catch (error) {
        settings.httpsEnabled = false;
        settings.lastCertError = (error as Error).message;
        await this.settingsRepository.save(settings);
        await this.nginxConfigService.render(settings);
        throw new BadRequestException(`Не удалось выпустить сертификат: ${(error as Error).message}`);
      }
    } else {
      settings.httpsEnabled = nextHttpsEnabled;
    }

    const saved = await this.settingsRepository.save(settings);
    setCorsAllowedDomain(saved.domain);
    await this.nginxConfigService.render(saved);
    return saved;
  }

  async renewCertificateNow(force: boolean): Promise<SystemSettings> {
    const settings = await this.getOrCreate();
    if (!settings.domain || !settings.letsEncryptEmail) {
      throw new BadRequestException('Сначала настройте домен и email в разделе "Домен и HTTPS"');
    }
    try {
      await this.certbotService.renew(force);
      settings.certExpiresAt = await this.certbotService.readCertExpiry(settings.domain);
      settings.lastCertError = null;
    } catch (error) {
      settings.lastCertError = (error as Error).message;
      await this.settingsRepository.save(settings);
      throw new BadRequestException(`Не удалось обновить сертификат: ${(error as Error).message}`);
    }
    const saved = await this.settingsRepository.save(settings);
    await this.nginxConfigService.render(saved);
    return saved;
  }

  // Certbot сам решает, пора ли обновлять (no-op, если до истечения ещё далеко) —
  // никакой собственной логики "пора или нет" здесь не нужно.
  @Cron('0 3 * * *')
  private async autoRenew(): Promise<void> {
    const settings = await this.getOrCreate();
    if (!settings.httpsEnabled || !settings.domain || !settings.letsEncryptEmail) {
      return;
    }
    try {
      await this.certbotService.renew(false);
      settings.certExpiresAt = await this.certbotService.readCertExpiry(settings.domain);
      settings.lastCertError = null;
      await this.settingsRepository.save(settings);
      await this.nginxConfigService.render(settings);
    } catch (error) {
      this.logger.error(`Автообновление сертификата не удалось: ${(error as Error).message}`);
      settings.lastCertError = (error as Error).message;
      await this.settingsRepository.save(settings);
    }
  }
}
