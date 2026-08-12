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
const MENU_PHONE_LABEL = '📱 Телефон';
const MENU_PC_LABEL = '💻 ПК';

type DraftStep = 'awaiting_org_name' | 'awaiting_inn' | 'awaiting_fio';

interface Draft {
  step: DraftStep;
  telegramUsername: string | null;
  orgName?: string;
  organizationId?: string;
}

// Состояние текущего запроса конфига (устройство → протокол → сервер/мост, если вариантов
// больше одного → подтверждение перевыпуска) — держим в памяти по chat id вместо того, чтобы
// пытаться пропихнуть все эти данные через callback_data (у Telegram там лимит 64 байта, а
// вариантов серверов может быть несколько с длинными uuid). Тот же принцип, что и у drafts
// регистрации — переживает только текущий процесс backend.
interface PeerRequest {
  deviceType: PeerDeviceType;
  protocol?: VpnProtocol;
  upstreamOptions?: Array<{ key: string; label: string }>;
  upstreamKey?: string;
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
  // прерывает диалог посреди регистрации/запроса конфига, пользователь начинает заново.
  private offset = 0;
  private readonly drafts = new Map<string, Draft>();
  private readonly peerRequests = new Map<string, PeerRequest>();
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

    // Кнопки постоянной клавиатуры (sendMainMenu) приходят как обычный текст — не через
    // callback_query — поэтому обрабатываются здесь же, а не только в handleCallback.
    if (text === MENU_PHONE_LABEL || text === MENU_PC_LABEL) {
      this.peerRequests.set(chatId, { deviceType: text === MENU_PHONE_LABEL ? PeerDeviceType.PHONE : PeerDeviceType.PC });
      await this.promptProtocolChoice(chatId);
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

  // Постоянная клавиатура (не inline) — в отличие от inline-кнопок, привязанных к
  // конкретному сообщению и пропадающих из вида при прокрутке/после нажатия, эта остаётся
  // внизу чата всегда, пока явно не заменить/не убрать (remove_keyboard). Отправляется один
  // раз при подтверждении регистрации (notifyApproved) — дальше пользователю не нужно
  // ничего вспоминать вроде /start, кнопки просто всегда под рукой.
  private async sendMainMenu(chatId: string): Promise<void> {
    await this.notificationsService.sendToChat(chatId, 'Выберите, для какого устройства получить конфиг:', {
      keyboard: [[{ text: MENU_PHONE_LABEL }, { text: MENU_PC_LABEL }]],
      resize_keyboard: true,
      is_persistent: true,
    });
  }

  // Выбор протокола — уже одноразовый inline-выбор под конкретным сообщением (это нормально:
  // это не основная навигация, а разовое уточнение к текущему запросу). deviceType к этому
  // моменту уже лежит в peerRequests — callback_data достаточно короткого фиксированного вида.
  private async promptProtocolChoice(chatId: string): Promise<void> {
    await this.notificationsService.sendToChat(chatId, 'Выберите протокол:', {
      inline_keyboard: [
        [
          { text: 'AmneziaWG', callback_data: 'protocol:amneziawg' },
          { text: 'WireGuard', callback_data: 'protocol:wireguard' },
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
    const request = this.peerRequests.get(chatId);

    const protocolMatch = data.match(/^protocol:(amneziawg|wireguard)$/);
    if (protocolMatch) {
      // request отсутствует, если backend перезапускался между нажатием кнопки устройства и
      // этим шагом — восстановить контекст неоткуда, просим начать заново явно, а не молчать.
      if (!request) {
        await this.notificationsService.sendToChat(chatId, 'Сессия запроса устарела, нажмите «Телефон»/«ПК» ещё раз.');
        return;
      }
      request.protocol = protocolMatch[1] === 'amneziawg' ? VpnProtocol.AMNEZIAWG : VpnProtocol.WIREGUARD;
      await this.proceedAfterProtocol(chatId, registration, organization, request);
      return;
    }

    const upstreamMatch = data.match(/^upstream:(\d+)$/);
    if (upstreamMatch && request?.upstreamOptions) {
      const option = request.upstreamOptions[Number(upstreamMatch[1])];
      if (!option) {
        await this.notificationsService.sendToChat(chatId, 'Этот вариант больше недоступен, начните заново.');
        this.peerRequests.delete(chatId);
        return;
      }
      await this.confirmOrIssue(chatId, registration, organization, request, option.key);
      return;
    }

    if (data === 'reissue:yes' || data === 'reissue:no') {
      if (data === 'reissue:no') {
        await this.notificationsService.sendToChat(chatId, 'Отменено.');
        this.peerRequests.delete(chatId);
        return;
      }
      if (!request?.protocol) {
        await this.notificationsService.sendToChat(chatId, 'Сессия запроса устарела, начните заново.');
        return;
      }
      await this.issuePeer(chatId, registration, organization, request, true);
    }
  }

  // Один доступный вариант сервера/моста (типичный случай) — пропускаем шаг выбора и сразу
  // создаём/проверяем перевыпуск; несколько — спрашиваем явно ("мост «X»"/"напрямую: Y").
  private async proceedAfterProtocol(
    chatId: string,
    registration: TelegramRegistration,
    organization: Organization,
    request: PeerRequest,
  ): Promise<void> {
    const options = await this.peersService.listUpstreamOptions(organization, request.protocol!);
    if (options.length === 0) {
      await this.notificationsService.sendToChat(chatId, 'Для вашей организации ещё не настроен доступ ни к одному серверу или мосту.');
      this.peerRequests.delete(chatId);
      return;
    }
    if (options.length === 1) {
      await this.confirmOrIssue(chatId, registration, organization, request, options[0].key);
      return;
    }
    request.upstreamOptions = options;
    await this.notificationsService.sendToChat(chatId, 'Выберите сервер:', {
      inline_keyboard: options.map((option, index) => [{ text: option.label, callback_data: `upstream:${index}` }]),
    });
  }

  // upstreamKey уже известен (единственный вариант или явный выбор) — осталось только
  // спросить подтверждение, если для этого устройства уже есть конфиг, либо выдать сразу.
  private async confirmOrIssue(
    chatId: string,
    registration: TelegramRegistration,
    organization: Organization,
    request: PeerRequest,
    upstreamKey: string,
  ): Promise<void> {
    request.upstreamKey = upstreamKey;
    const existingPeers = await this.peersService.findActivePeersForTelegramRegistration(registration.id);
    if (existingPeers.some((peer) => peer.deviceType === request.deviceType)) {
      await this.notificationsService.sendToChat(
        chatId,
        'У вас уже есть конфиг для этого устройства. Перевыпустить? Старый конфиг перестанет работать.',
        {
          inline_keyboard: [
            [
              { text: 'Да, перевыпустить', callback_data: 'reissue:yes' },
              { text: 'Отмена', callback_data: 'reissue:no' },
            ],
          ],
        },
      );
      return;
    }
    await this.issuePeer(chatId, registration, organization, request, false);
  }

  private async issuePeer(
    chatId: string,
    registration: TelegramRegistration,
    organization: Organization,
    request: PeerRequest,
    reissue: boolean,
  ): Promise<void> {
    const upstreamKey = request.upstreamKey;
    try {
      const { filename, content } = reissue
        ? await this.peersService.reissueForTelegramRegistration(registration, organization, request.protocol!, request.deviceType, upstreamKey)
        : await this.peersService.createForTelegramRegistration(registration, organization, request.protocol!, request.deviceType, upstreamKey);
      await this.notificationsService.sendDocumentToChat(chatId, filename, content);
      const png = await QRCode.toBuffer(content, { type: 'png', width: 400 });
      await this.notificationsService.sendPhotoToChat(chatId, png, 'QR-код для быстрого подключения');
    } catch (error) {
      this.logger.warn(`Не удалось выдать peer для чата ${chatId}: ${(error as Error).message}`);
      await this.notificationsService.sendToChat(chatId, `Не удалось создать конфиг: ${(error as Error).message}`);
    } finally {
      this.peerRequests.delete(chatId);
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
