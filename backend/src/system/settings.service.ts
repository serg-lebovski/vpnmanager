import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { setCorsAllowedDomain } from '../common/cors-origin.state';
import { encryptSecret } from '../common/encryption.util';
import { NotificationsService } from '../notifications/notifications.service';
import { Server } from '../servers/server.entity';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { CertbotService } from './certbot.service';
import { NginxConfigService } from './nginx-config.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SystemSettings } from './system-settings.entity';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(SystemSettings) private readonly settingsRepository: Repository<SystemSettings>,
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    private readonly certbotService: CertbotService,
    private readonly nginxConfigService: NginxConfigService,
    private readonly vpnProvisioningService: VpnProvisioningService,
    private readonly notificationsService: NotificationsService,
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

    if (dto.telegramEnabled !== undefined) {
      settings.telegramEnabled = dto.telegramEnabled;
    }
    if (dto.telegramBotToken !== undefined) {
      settings.telegramBotTokenEnc = encryptSecret(dto.telegramBotToken);
    }
    if (dto.telegramChatId !== undefined) {
      settings.telegramChatId = dto.telegramChatId;
    }
    const telegramBridgeChanged = dto.telegramBridgeId !== undefined && dto.telegramBridgeId !== settings.telegramBridgeId;
    if (dto.telegramBridgeId !== undefined) {
      settings.telegramBridgeId = dto.telegramBridgeId;
    }

    const saved = await this.settingsRepository.save(settings);
    setCorsAllowedDomain(saved.domain);
    await this.nginxConfigService.render(saved);

    // Best-effort, не блокирует сохранение настроек — self-сервер может быть временно
    // недоступен, маршрутизацию всегда можно настроить повторно, просто сохранив
    // настройки ещё раз (идемпотентно, см. setupTelegramRouting).
    if (telegramBridgeChanged && saved.telegramBridgeId) {
      this.setupTelegramRoutingBestEffort(saved.telegramBridgeId);
    }

    return saved;
  }

  private setupTelegramRoutingBestEffort(bridgeId: string): void {
    this.bridgesRepository
      .findOne({ where: { id: bridgeId }, relations: ['wireguardClientProtocol.server', 'amneziawgClientProtocol.server'] })
      .then((bridge) => {
        const selfServer = bridge?.wireguardClientProtocol?.server ?? bridge?.amneziawgClientProtocol?.server;
        if (!bridge || !selfServer) {
          this.logger.warn(`Не удалось настроить маршрутизацию Telegram через мост ${bridgeId} — мост или self-сервер не найден`);
          return;
        }
        return this.vpnProvisioningService.setupTelegramRouting(selfServer, bridge);
      })
      .catch((error) => {
        this.logger.warn(`Не удалось настроить маршрутизацию Telegram через мост: ${(error as Error).message}`);
      });
  }

  // Кнопка "Отправить тестовое сообщение" в Настройках — сразу видно, работает ли
  // конфигурация (в т.ч. маршрутизация через мост), не дожидаясь реального события вроде
  // истечения peer'а или ошибки обновления сертификата.
  async sendTestTelegramMessage(): Promise<void> {
    const settings = await this.getOrCreate();
    if (!settings.telegramEnabled || !settings.telegramBotTokenEnc || !settings.telegramChatId) {
      throw new BadRequestException('Сначала включите и настройте уведомления в Telegram (токен бота и chat id)');
    }
    try {
      await this.notificationsService.sendTestMessage('🔔 Тестовое сообщение от VPN Manager — уведомления настроены верно.');
    } catch (error) {
      throw new BadRequestException(`Telegram не принял сообщение: ${(error as Error).message}`);
    }
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
      await this.notificationsService.sendMessage(
        `⚠️ Не удалось автоматически обновить сертификат для ${settings.domain}: ${(error as Error).message}`,
      );
    }
  }
}
