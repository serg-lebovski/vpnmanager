import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import * as QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { PeerDeviceType, LogLevel, TelegramRegistrationStatus, VpnProtocol } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { Organization } from '../organizations/organization.entity';
import { PeersService } from '../peers/peers.service';
import { MtProxyService, MtProxyStatus } from '../servers/mtproxy.service';
import { IssuePortalConfigDto } from './dto/issue-portal-config.dto';
import { findOrganizationByQuery } from './organization-lookup.util';
import { TelegramBotLog } from './telegram-bot-log.entity';
import { TelegramRegistration } from './telegram-registration.entity';

export interface PortalDeviceStatus {
  deviceType: PeerDeviceType;
  createdAt: Date;
}

export interface PortalStatus {
  fullName: string;
  organizationName: string;
  status: TelegramRegistrationStatus;
  linkedToTelegram: boolean;
  devices: PortalDeviceStatus[];
  // Ссылка на бота с этим же токеном как start-payload (t.me/<бот>?start=<webToken>) — null,
  // если бот не настроен/username не удалось определить. Показывается даже уже привязанным
  // к Telegram заявкам — не мешает, а лишний способ вернуться в бота не помешает.
  botDeepLink: string | null;
  // Постоянная ссылка на MTProto-proxy self-сервера (см. MtProxyService) — null, если он ещё
  // не установлен администратором. Одна и та же ссылка для всех клиентов (не индивидуальная
  // сессия, как в отказавшейся от себя первой версии) — это публичный, обфусцированный
  // способ обхода блокировки самого Telegram, а не привилегия конкретной заявки.
  mtProxy: MtProxyStatus | null;
}

// Публичный (без JwtAuthGuard) веб-канал регистрации/доступа к конфигам — для клиентов без
// доступа к Telegram (см. обсуждение в задаче). Единственная защита — сам токен
// (TelegramRegistration.webToken, crypto-случайный UUID в URL), той же природы, что и
// одноразовые ссылки сброса пароля в других системах. Переиспользует уже готовые,
// канало-агностичные методы PeersService (createForTelegramRegistration и т.д.) — та же
// логика, что и у TelegramBotService, просто без Telegram-специфичной части (диалоги,
// callback_data).
@Injectable()
export class TelegramPortalService {
  constructor(
    @InjectRepository(TelegramRegistration) private readonly registrationsRepository: Repository<TelegramRegistration>,
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
    @InjectRepository(TelegramBotLog) private readonly logsRepository: Repository<TelegramBotLog>,
    private readonly peersService: PeersService,
    private readonly notificationsService: NotificationsService,
    private readonly mtProxyService: MtProxyService,
  ) {}

  async register(orgQuery: string, fullName: string): Promise<{ webToken: string }> {
    const organization = await findOrganizationByQuery(this.organizationsRepository, orgQuery);
    if (!organization) {
      throw new NotFoundException('Не нашли организацию с таким названием или ИНН. Проверьте данные.');
    }
    const registration = this.registrationsRepository.create({
      telegramChatId: null,
      telegramUsername: null,
      organizationId: organization.id,
      fullName: fullName.trim(),
      status: TelegramRegistrationStatus.PENDING,
      webToken: randomUUID(),
    });
    await this.registrationsRepository.save(registration);
    await this.logsRepository.insert({
      level: LogLevel.INFO,
      message: `Новая веб-заявка на регистрацию: ${registration.fullName}`,
      chatId: null,
    });
    return { webToken: registration.webToken! };
  }

  private async findByToken(token: string): Promise<TelegramRegistration> {
    const registration = await this.registrationsRepository.findOne({ where: { webToken: token }, relations: ['organization'] });
    if (!registration) {
      throw new NotFoundException('Ссылка недействительна — проверьте её или зарегистрируйтесь заново.');
    }
    return registration;
  }

  async getStatus(token: string): Promise<PortalStatus> {
    const registration = await this.findByToken(token);
    const peers =
      registration.status === TelegramRegistrationStatus.APPROVED
        ? await this.peersService.findActivePeersForTelegramRegistration(registration.id)
        : [];
    const botUsername = await this.notificationsService.getBotUsername();
    const mtProxy = await this.mtProxyService.getSelfServerStatus();
    return {
      fullName: registration.fullName,
      organizationName: registration.organization.name,
      status: registration.status,
      linkedToTelegram: !!registration.telegramChatId,
      devices: peers
        .filter((p): p is typeof p & { deviceType: PeerDeviceType } => p.deviceType !== null)
        .map((p) => ({ deviceType: p.deviceType, createdAt: p.createdAt })),
      botDeepLink: botUsername ? `https://t.me/${botUsername}?start=${token}` : null,
      mtProxy,
    };
  }

  async listUpstreamOptions(token: string, protocol: VpnProtocol): Promise<Array<{ key: string; label: string }>> {
    const registration = await this.findByToken(token);
    if (registration.status !== TelegramRegistrationStatus.APPROVED) {
      throw new ForbiddenException('Заявка ещё не подтверждена администратором');
    }
    return this.peersService.listUpstreamOptions(registration.organization, protocol);
  }

  async issueConfig(token: string, dto: IssuePortalConfigDto): Promise<{ filename: string; content: string; qrDataUri: string }> {
    const registration = await this.findByToken(token);
    if (registration.status !== TelegramRegistrationStatus.APPROVED) {
      throw new ForbiddenException('Заявка ещё не подтверждена администратором');
    }
    this.requireLinkedTelegram(registration);
    const existing = await this.peersService.findActivePeersForTelegramRegistration(registration.id);
    const hasExisting = existing.some((p) => p.deviceType === dto.deviceType);
    const result = hasExisting
      ? await this.peersService.reissueForTelegramRegistration(
          registration,
          registration.organization,
          dto.protocol,
          dto.deviceType,
          dto.upstreamKey,
        )
      : await this.peersService.createForTelegramRegistration(
          registration,
          registration.organization,
          dto.protocol,
          dto.deviceType,
          dto.upstreamKey,
        );
    await this.logsRepository.insert({
      level: LogLevel.INFO,
      message: `${hasExisting ? 'Перевыпущен' : 'Выдан'} peer через веб-портал: «${result.filename.replace(/\.conf$/, '')}»`,
      chatId: null,
    });
    return this.withQr(result);
  }

  // Повторное скачивание УЖЕ выданного конфига (кнопка «Скачать» рядом с уже выданным
  // устройством в PortalPage.tsx) — в отличие от issueConfig не трогает ключи/сервер, просто
  // ещё раз отдаёт то же самое содержимое + QR.
  async downloadConfig(token: string, deviceType: PeerDeviceType): Promise<{ filename: string; content: string; qrDataUri: string }> {
    const registration = await this.findByToken(token);
    if (registration.status !== TelegramRegistrationStatus.APPROVED) {
      throw new ForbiddenException('Заявка ещё не подтверждена администратором');
    }
    this.requireLinkedTelegram(registration);
    const result = await this.peersService.getDownloadableConfigForTelegramRegistration(registration.id, deviceType);
    return this.withQr(result);
  }

  // Обязательная привязка Telegram (явное решение пользователя) — портал остаётся точкой
  // входа/восстановления доступа, но выдача конфигов требует, чтобы заявка стала достижима
  // и через бота тоже (рассылки/уведомления, единый канал связи с клиентом). Если у клиента
  // Telegram заблокирован — см. MtProxyService: постоянный MTProto-proxy self-сервера,
  // ссылка на который уже показана выше на этой же странице (PortalStatus.mtProxy).
  private requireLinkedTelegram(registration: TelegramRegistration): void {
    if (!registration.telegramChatId) {
      throw new ForbiddenException(
        'Сначала привяжите Telegram (кнопка выше) — конфиги выдаются только после привязки.',
      );
    }
  }

  private async withQr(result: { filename: string; content: string }): Promise<{ filename: string; content: string; qrDataUri: string }> {
    const png = await QRCode.toBuffer(result.content, { type: 'png', width: 400 });
    return { ...result, qrDataUri: `data:image/png;base64,${png.toString('base64')}` };
  }
}
