import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import * as QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { PeerDeviceType, TelegramRegistrationStatus, VpnProtocol } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { Organization } from '../organizations/organization.entity';
import { PeersService } from '../peers/peers.service';
import { TelegramRegistration } from './telegram-registration.entity';

const POLL_INTERVAL_MS = 3_000;
const API_TIMEOUT_MS = 10_000;

type DraftStep = 'awaiting_org_name' | 'awaiting_inn' | 'awaiting_fio';

interface Draft {
  step: DraftStep;
  telegramUsername: string | null;
  orgName?: string;
  organizationId?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number; username?: string }; text?: string };
  callback_query?: { id: string; data?: string; message: { chat: { id: number } } };
}

// Long polling (getUpdates), а не webhook — работает на любом деплое независимо от того,
// настроен ли домен/HTTPS у панели (SystemSettings.domain/httpsEnabled — опциональные).
// Использует тот же токен бота, что и алерты (SystemSettings.telegramBotTokenEnc, см.
// NotificationsService.getDecryptedBotToken) — второй бот не заводим.
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  // offset и черновики диалогов — только в памяти процесса (тот же trade-off, что у
  // BridgeFailoverService.stateByServerId/PeersService.appliedExpiry): рестарт backend
  // прерывает диалог посреди регистрации, пользователь начинает заново с /start.
  private offset = 0;
  private readonly drafts = new Map<string, Draft>();
  private polling = false;

  constructor(
    @InjectRepository(TelegramRegistration) private readonly registrationsRepository: Repository<TelegramRegistration>,
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
    private readonly notificationsService: NotificationsService,
    private readonly peersService: PeersService,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  private async poll(): Promise<void> {
    // Защита от наложения тиков, если один getUpdates почему-то не уложился в интервал.
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const token = await this.notificationsService.getDecryptedBotToken();
      if (!token) {
        return;
      }
      const updates = await this.getUpdates(token);
      for (const update of updates) {
        this.offset = update.update_id + 1;
        try {
          await this.handleUpdate(update);
        } catch (error) {
          this.logger.warn(`Ошибка обработки Telegram-обновления: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Не удалось опросить Telegram getUpdates: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async getUpdates(token: string): Promise<TelegramUpdate[]> {
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${this.offset}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`getUpdates вернул ${response.status}`);
    }
    const body = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
    return body.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text) {
      return;
    }
    const chatId = String(message.chat.id);
    const text = message.text.trim();

    if (text === '/start') {
      await this.handleStart(chatId, message.chat.username ?? null);
      return;
    }

    const draft = this.drafts.get(chatId);
    if (draft) {
      await this.handleDraftStep(chatId, draft, text);
      return;
    }

    const registration = await this.registrationsRepository.findOne({ where: { telegramChatId: chatId } });
    if (!registration) {
      await this.notificationsService.sendToChat(chatId, 'Отправьте /start, чтобы начать регистрацию.');
      return;
    }
    if (registration.status !== TelegramRegistrationStatus.APPROVED) {
      await this.notificationsService.sendToChat(chatId, 'Ваша заявка ещё не подтверждена администратором.');
      return;
    }
    await this.sendMainMenu(chatId);
  }

  private async handleStart(chatId: string, telegramUsername: string | null): Promise<void> {
    const existing = await this.registrationsRepository.findOne({ where: { telegramChatId: chatId } });
    if (existing) {
      if (existing.status === TelegramRegistrationStatus.APPROVED) {
        await this.sendMainMenu(chatId);
      } else {
        await this.notificationsService.sendToChat(chatId, 'Ваша заявка уже отправлена и ожидает подтверждения администратора.');
      }
      return;
    }
    this.drafts.set(chatId, { step: 'awaiting_org_name', telegramUsername });
    await this.notificationsService.sendToChat(chatId, 'Здравствуйте! Введите точное название вашей организации.');
  }

  private async handleDraftStep(chatId: string, draft: Draft, text: string): Promise<void> {
    if (draft.step === 'awaiting_org_name') {
      draft.orgName = text;
      draft.step = 'awaiting_inn';
      await this.notificationsService.sendToChat(chatId, 'Теперь введите ИНН организации.');
      return;
    }

    if (draft.step === 'awaiting_inn') {
      const organization = await this.organizationsRepository.findOne({ where: { inn: text } });
      if (!organization || organization.name.trim().toLowerCase() !== (draft.orgName ?? '').trim().toLowerCase()) {
        this.drafts.delete(chatId);
        await this.notificationsService.sendToChat(
          chatId,
          'Не нашёл организацию с таким названием и ИНН. Проверьте данные и начните заново с /start.',
        );
        return;
      }
      draft.organizationId = organization.id;
      draft.step = 'awaiting_fio';
      await this.notificationsService.sendToChat(chatId, 'Организация найдена. Введите ваши фамилию, имя и отчество.');
      return;
    }

    if (draft.step === 'awaiting_fio') {
      const registration = this.registrationsRepository.create({
        telegramChatId: chatId,
        telegramUsername: draft.telegramUsername,
        organizationId: draft.organizationId!,
        fullName: text,
        status: TelegramRegistrationStatus.PENDING,
      });
      await this.registrationsRepository.save(registration);
      this.drafts.delete(chatId);
      await this.notificationsService.sendToChat(chatId, 'Заявка отправлена. Ожидайте подтверждения администратора.');
    }
  }

  private async sendMainMenu(chatId: string): Promise<void> {
    await this.notificationsService.sendToChat(chatId, 'Выберите, для какого устройства получить конфиг:', {
      inline_keyboard: [
        [
          { text: '📱 Телефон', callback_data: 'device:phone' },
          { text: '💻 ПК', callback_data: 'device:pc' },
        ],
      ],
    });
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = String(callback.message.chat.id);
    await this.notificationsService.answerCallbackQuery(callback.id);
    const data = callback.data ?? '';

    const registration = await this.registrationsRepository.findOne({ where: { telegramChatId: chatId } });
    if (!registration || registration.status !== TelegramRegistrationStatus.APPROVED) {
      await this.notificationsService.sendToChat(chatId, 'Ваша заявка ещё не подтверждена администратором.');
      return;
    }
    const organization = await this.organizationsRepository.findOneOrFail({ where: { id: registration.organizationId } });

    if (data === 'device:phone' || data === 'device:pc') {
      const deviceType = data === 'device:phone' ? PeerDeviceType.PHONE : PeerDeviceType.PC;
      const existingPeers = await this.peersService.findActivePeersForTelegramRegistration(registration.id);
      if (existingPeers.some((peer) => peer.deviceType === deviceType)) {
        await this.notificationsService.sendToChat(
          chatId,
          'У вас уже есть конфиг для этого устройства. Перевыпустить? Старый конфиг перестанет работать.',
          {
            inline_keyboard: [
              [
                { text: 'Да, перевыпустить', callback_data: `reissue:${deviceType}:yes` },
                { text: 'Отмена', callback_data: `reissue:${deviceType}:no` },
              ],
            ],
          },
        );
        return;
      }
      await this.issuePeer(chatId, registration, organization, deviceType, false);
      return;
    }

    const reissueMatch = data.match(/^reissue:(phone|pc):(yes|no)$/);
    if (reissueMatch) {
      const deviceType = reissueMatch[1] === 'phone' ? PeerDeviceType.PHONE : PeerDeviceType.PC;
      if (reissueMatch[2] === 'no') {
        await this.notificationsService.sendToChat(chatId, 'Отменено.');
        return;
      }
      await this.issuePeer(chatId, registration, organization, deviceType, true);
    }
  }

  private async issuePeer(
    chatId: string,
    registration: TelegramRegistration,
    organization: Organization,
    deviceType: PeerDeviceType,
    reissue: boolean,
  ): Promise<void> {
    try {
      const { filename, content } = reissue
        ? await this.peersService.reissueForTelegramRegistration(registration, organization, VpnProtocol.AMNEZIAWG, deviceType)
        : await this.peersService.createForTelegramRegistration(registration, organization, VpnProtocol.AMNEZIAWG, deviceType);
      await this.notificationsService.sendDocumentToChat(chatId, filename, content);
      const png = await QRCode.toBuffer(content, { type: 'png', width: 400 });
      await this.notificationsService.sendPhotoToChat(chatId, png, 'QR-код для быстрого подключения');
    } catch (error) {
      this.logger.warn(`Не удалось выдать peer для чата ${chatId}: ${(error as Error).message}`);
      await this.notificationsService.sendToChat(chatId, `Не удалось создать конфиг: ${(error as Error).message}`);
    }
  }

  // Вызывается TelegramRegistrationsService при подтверждении заявки суперадмином —
  // best-effort, неудачная отправка не должна блокировать само подтверждение.
  async notifyApproved(chatId: string): Promise<void> {
    try {
      await this.notificationsService.sendToChat(chatId, 'Ваша регистрация подтверждена!');
      await this.sendMainMenu(chatId);
    } catch (error) {
      this.logger.warn(`Не удалось уведомить чат ${chatId} о подтверждении: ${(error as Error).message}`);
    }
  }
}
