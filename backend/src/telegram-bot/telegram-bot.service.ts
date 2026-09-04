import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import * as QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { PeerDeviceType, LogLevel, TelegramContentKind, TelegramRegistrationStatus, VpnProtocol } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { Organization } from '../organizations/organization.entity';
import { PeersService } from '../peers/peers.service';
import { markdownToTelegramHtml } from './markdown-to-telegram-html.util';
import { findOrganizationByQuery } from './organization-lookup.util';
import { TelegramBotLog } from './telegram-bot-log.entity';
import { TelegramContentPost } from './telegram-content-post.entity';
import { TelegramContentService } from './telegram-content.service';
import { TelegramRegistration } from './telegram-registration.entity';

// Плейсхолдер, который вставляет редактор новостей/инструкций (TelegramBotPage.tsx) прямо
// в текст поста в месте, куда администратор поставил картинку — см. ContentSection.
// insertImageAtCursor. N — индекс в TelegramContentPost.images. Старые посты (созданные до
// этой фичи) плейсхолдеров не содержат — их картинки просто уходят следом за текстом целиком,
// тем же способом, что и раньше (см. sendContentPost ниже).
const INLINE_IMAGE_TOKEN = /\[\[img:(\d+)\]\]/g;

const POLL_INTERVAL_MS = 3_000;
const API_TIMEOUT_MS = 10_000;
const MENU_PHONE_LABEL = '📱 Телефон';
const MENU_PC_LABEL = '💻 ПК';
const MENU_PORTAL_LABEL = '🌐 Доступ к порталу';
const MENU_CHANGE_PROTOCOL_LABEL = '🔁 Сменить протокол';
const MENU_NEWS_LABEL = '📰 Новости';
const MENU_INSTRUCTIONS_LABEL = '📘 Инструкции';
const NEWS_FEED_LIMIT = 5;

type DraftStep = 'awaiting_org' | 'awaiting_fio';

interface Draft {
  step: DraftStep;
  telegramUsername: string | null;
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
  // Мультиконфиг — WireGuard + AmneziaWG одним .vpn-файлом (см. PeersService.
  // createMultiProtocolForTelegramRegistration), взаимоисключимо с protocol.
  multiProtocol?: boolean;
  upstreamOptions?: Array<{ key: string; label: string; isDefault?: boolean }>;
  upstreamKey?: string;
  // true — запрос пришёл с кнопки "Сменить протокол": пользователь уже явно осознаёт, что
  // текущий конфиг для этого устройства будет заменён, отдельное "уже есть, перевыпустить?"
  // подтверждение (как при обычном запросе через "Телефон"/"ПК") избыточно.
  explicitReissue?: boolean;
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
    @InjectRepository(TelegramBotLog) private readonly logsRepository: Repository<TelegramBotLog>,
    private readonly notificationsService: NotificationsService,
    private readonly peersService: PeersService,
    private readonly telegramContentService: TelegramContentService,
  ) {}

  // Пишет и в docker logs (как раньше), и в БД, чтобы событие было видно в панели (вкладка
  // Telegram) без захода по SSH. chatId — для контекста "чья это заявка/запрос", не FK
  // (заявка могла быть уже удалена к моменту просмотра лога).
  private async log(level: LogLevel, message: string, chatId?: string): Promise<void> {
    const logMethod = level === LogLevel.ERROR ? 'error' : level === LogLevel.WARN ? 'warn' : 'log';
    this.logger[logMethod](chatId ? `[${chatId}] ${message}` : message);
    try {
      await this.logsRepository.insert({ level, message, chatId: chatId ?? null });
    } catch (error) {
      this.logger.warn(`Не удалось записать событие в журнал Telegram-бота: ${(error as Error).message}`);
    }
  }

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

    const startMatch = text.match(/^\/start(?:\s+(\S+))?$/);
    if (startMatch) {
      await this.handleStart(chatId, message.chat.username ?? null, startMatch[1]);
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

    if (text === MENU_PORTAL_LABEL) {
      await this.promptPortalLink(chatId);
      return;
    }

    if (text === MENU_CHANGE_PROTOCOL_LABEL) {
      await this.startChangeProtocol(chatId, registration);
      return;
    }

    if (text === MENU_NEWS_LABEL) {
      await this.sendContentFeed(chatId, TelegramContentKind.NEWS, NEWS_FEED_LIMIT, 'Пока новостей нет.');
      return;
    }

    if (text === MENU_INSTRUCTIONS_LABEL) {
      await this.sendContentFeed(chatId, TelegramContentKind.INSTRUCTION, undefined, 'Инструкции пока не добавлены.');
      return;
    }

    await this.sendMainMenu(chatId);
  }

  // Новости — последние NEWS_FEED_LIMIT штук (лента может расти неограниченно, отправлять
  // всё целиком каждый раз не нужно); инструкции — все сразу (limit=undefined, их обычно
  // немного, и это не растущая лента, а справочный набор карточек).
  private async sendContentFeed(
    chatId: string,
    kind: TelegramContentKind,
    limit: number | undefined,
    emptyText: string,
  ): Promise<void> {
    const posts = await this.telegramContentService.listForBot(kind, limit);
    if (posts.length === 0) {
      await this.notificationsService.sendToChat(chatId, emptyText);
      return;
    }
    for (const post of posts) {
      await this.sendContentPost(chatId, post);
    }
  }

  // Заголовок оформляется жирным той же markdown→HTML веткой, что и тело (см.
  // markdownToTelegramHtml) — единый конвейер вместо отдельного форматирования заголовка.
  // Тело режется по плейсхолдерам [[img:N]] (см. ContentSection.insertImageAtCursor во
  // фронтенде) на чередующиеся текстовые/картиночные сегменты — Telegram не умеет вставлять
  // изображение "внутрь" одного текстового сообщения, поэтому визуальный эффект "картинка
  // среди текста" достигается последовательностью отдельных сообщений в нужном порядке.
  // Картинки, на которые в тексте нет плейсхолдера (посты, созданные до этой фичи, или
  // просто "прикреплённые" без точной позиции), уходят следом, как и раньше.
  private async sendContentPost(chatId: string, post: TelegramContentPost): Promise<void> {
    const titlePrefix = post.title ? `**${post.title}**\n\n` : '';
    const fullBody = titlePrefix + post.body;

    const usedImageIndexes = new Set<number>();
    const segments: Array<{ text: string } | { imageIndex: number }> = [];
    let lastIndex = 0;
    for (const match of fullBody.matchAll(INLINE_IMAGE_TOKEN)) {
      const textBefore = fullBody.slice(lastIndex, match.index);
      if (textBefore.trim()) {
        segments.push({ text: textBefore });
      }
      const imageIndex = Number(match[1]);
      segments.push({ imageIndex });
      usedImageIndexes.add(imageIndex);
      lastIndex = match.index! + match[0].length;
    }
    const tail = fullBody.slice(lastIndex);
    if (tail.trim()) {
      segments.push({ text: tail });
    }

    for (const segment of segments) {
      if ('text' in segment) {
        const html = markdownToTelegramHtml(segment.text);
        if (html) {
          await this.notificationsService.sendToChat(chatId, html, undefined, 'HTML');
        }
      } else {
        await this.sendPostImage(chatId, post.images[segment.imageIndex]);
      }
    }
    for (let i = 0; i < post.images.length; i++) {
      if (!usedImageIndexes.has(i)) {
        await this.sendPostImage(chatId, post.images[i]);
      }
    }
  }

  private async sendPostImage(chatId: string, dataUri: string | undefined): Promise<void> {
    const parsed = dataUri && this.parseImageDataUri(dataUri);
    if (parsed) {
      await this.notificationsService.sendPhotoToChat(chatId, parsed.buffer, undefined, parsed.mimeType);
    }
  }

  private parseImageDataUri(dataUri: string): { buffer: Buffer; mimeType: string } | null {
    const match = dataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return null;
    }
    return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
  }

  // Определяет, для какого устройства менять протокол: если существующий конфиг только
  // один — сразу переходим к выбору протокола, если оба — спрашиваем явно, если ни одного —
  // менять пока нечего (сначала обычная выдача через "Телефон"/"ПК").
  private async startChangeProtocol(chatId: string, registration: TelegramRegistration): Promise<void> {
    const existingPeers = await this.peersService.findActivePeersForTelegramRegistration(registration.id);
    // new Set — мультиконфиг даёт ДВА peer'а (WireGuard + AmneziaWG) с одним и тем же
    // deviceType, без дедупликации устройство считалось бы "выбором из двух" само с собой.
    const devices = [...new Set(existingPeers.map((peer) => peer.deviceType).filter((d): d is PeerDeviceType => d !== null))];
    if (devices.length === 0) {
      await this.notificationsService.sendToChat(
        chatId,
        'У вас пока нет ни одного конфига — сначала получите его через «Телефон» или «ПК».',
      );
      return;
    }
    if (devices.length === 1) {
      this.peerRequests.set(chatId, { deviceType: devices[0], explicitReissue: true });
      await this.promptProtocolChoice(chatId);
      return;
    }
    await this.notificationsService.sendToChat(chatId, 'Для какого устройства сменить протокол?', {
      inline_keyboard: [
        [
          { text: '📱 Телефон', callback_data: 'changedevice:phone' },
          { text: '💻 ПК', callback_data: 'changedevice:pc' },
        ],
      ],
    });
  }

  private async promptPortalLink(chatId: string): Promise<void> {
    await this.notificationsService.sendToChat(
      chatId,
      'Ссылка на веб-портал — запасной способ скачать/перевыпустить ваши конфиги, если Telegram вдруг перестанет работать.',
      {
        inline_keyboard: [
          [{ text: 'Получить ссылку', callback_data: 'portallink:get' }],
          [{ text: 'Получить новую ссылку', callback_data: 'portallink:new' }],
        ],
      },
    );
  }

  // forceNew=false ("получить ссылку") — существующий токен, если уже есть, иначе
  // генерируем впервые. forceNew=true ("получить новую ссылку") — всегда перевыпускает
  // токен: старая ссылка перестаёт работать (тот же принцип, что и у admin-эндпоинта
  // GET .../portal-link, только этот путь ещё и умеет форсировать замену).
  private async sendPortalLink(chatId: string, registration: TelegramRegistration, forceNew: boolean): Promise<void> {
    if (forceNew || !registration.webToken) {
      registration.webToken = randomUUID();
      await this.registrationsRepository.save(registration);
      await this.log(LogLevel.INFO, `${forceNew ? 'Перевыпущена' : 'Выдана'} ссылка веб-портала`, chatId);
    }
    const base = await this.notificationsService.getPanelBaseUrl();
    if (!base) {
      await this.notificationsService.sendToChat(
        chatId,
        'Домен панели ещё не настроен администратором — сформировать ссылку пока нельзя.',
      );
      return;
    }
    const url = `${base}/portal/${registration.webToken}`;
    const prefix = forceNew ? 'Новая ссылка выдана, старая больше не действует:\n\n' : '';
    await this.notificationsService.sendToChat(chatId, `${prefix}${url}`);
  }

  // payload — из /start <payload>, если бота открыли по персональной ссылке веб-портала
  // (t.me/<бот>?start=<webToken>, см. TelegramPortalService/PortalPage.tsx) — привязываем
  // ЭТОТ чат к уже существующей веб-заявке вместо того, чтобы начинать регистрацию с нуля
  // (иначе один и тот же человек завёл бы вторую отдельную заявку и второй набор peers).
  private async handleStart(chatId: string, telegramUsername: string | null, payload?: string): Promise<void> {
    const existing = await this.registrationsRepository.findOne({ where: { telegramChatId: chatId } });
    if (existing) {
      if (existing.status === TelegramRegistrationStatus.APPROVED) {
        await this.sendMainMenu(chatId);
      } else {
        await this.notificationsService.sendToChat(chatId, 'Ваша заявка уже отправлена и ожидает подтверждения администратора.');
      }
      return;
    }

    if (payload) {
      const linked = await this.registrationsRepository.findOne({ where: { webToken: payload } });
      if (linked && !linked.telegramChatId) {
        linked.telegramChatId = chatId;
        linked.telegramUsername = telegramUsername;
        await this.registrationsRepository.save(linked);
        await this.log(LogLevel.INFO, `Telegram привязан к веб-заявке: ${linked.fullName}`, chatId);
        if (linked.status === TelegramRegistrationStatus.APPROVED) {
          await this.notificationsService.sendToChat(chatId, 'Telegram успешно привязан к вашей заявке.');
          await this.sendMainMenu(chatId);
        } else {
          await this.notificationsService.sendToChat(
            chatId,
            'Telegram привязан к вашей заявке. Она всё ещё ожидает подтверждения администратора.',
          );
        }
        return;
      }
    }

    this.drafts.set(chatId, { step: 'awaiting_org', telegramUsername });
    const welcome = await this.notificationsService.getWelcomeMessage();
    await this.notificationsService.sendToChat(chatId, welcome);
    await this.notificationsService.sendToChat(chatId, 'Введите название вашей организации или её ИНН.');
  }

  private async handleDraftStep(chatId: string, draft: Draft, text: string): Promise<void> {
    if (draft.step === 'awaiting_org') {
      const query = text.trim();
      const organization = await findOrganizationByQuery(this.organizationsRepository, query);
      if (!organization) {
        this.drafts.delete(chatId);
        await this.log(LogLevel.WARN, `Не удалось найти организацию по запросу «${query}»`, chatId);
        await this.notificationsService.sendToChat(
          chatId,
          'Не нашёл организацию с таким названием или ИНН. Проверьте данные и начните заново с /start.',
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
        // Токен веб-портала — сразу и бот-заявкам тоже: даже клиент, зарегистрировавшийся
        // через Telegram, получает бесплатный запасной способ достучаться до конфигов, если
        // Telegram у него потом перестанет работать (ссылку можно выдать из «Регистрации» в
        // панели, GET .../portal-link).
        webToken: randomUUID(),
      });
      await this.registrationsRepository.save(registration);
      this.drafts.delete(chatId);
      await this.log(LogLevel.INFO, `Новая заявка на регистрацию: ${text}`, chatId);
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
      keyboard: [
        [{ text: MENU_PHONE_LABEL }, { text: MENU_PC_LABEL }],
        [{ text: MENU_CHANGE_PROTOCOL_LABEL }],
        [{ text: MENU_NEWS_LABEL }, { text: MENU_INSTRUCTIONS_LABEL }],
        [{ text: MENU_PORTAL_LABEL }],
      ],
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
        // Мультиконфиг — один .vpn-файл для приложения AmneziaVPN, протокол переключается
        // прямо внутри приложения без повторного импорта (см. amnezia-config.util.ts).
        [{ text: '🔀 WireGuard + AmneziaWG (мультиконфиг)', callback_data: 'protocol:multi' }],
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

    const protocolMatch = data.match(/^protocol:(amneziawg|wireguard|multi)$/);
    if (protocolMatch) {
      // request отсутствует, если backend перезапускался между нажатием кнопки устройства и
      // этим шагом — восстановить контекст неоткуда, просим начать заново явно, а не молчать.
      if (!request) {
        await this.notificationsService.sendToChat(chatId, 'Сессия запроса устарела, нажмите «Телефон»/«ПК» ещё раз.');
        return;
      }
      if (protocolMatch[1] === 'multi') {
        request.multiProtocol = true;
      } else {
        request.protocol = protocolMatch[1] === 'amneziawg' ? VpnProtocol.AMNEZIAWG : VpnProtocol.WIREGUARD;
      }
      await this.proceedAfterProtocol(chatId, registration, organization, request);
      return;
    }

    const portalLinkMatch = data.match(/^portallink:(get|new)$/);
    if (portalLinkMatch) {
      await this.sendPortalLink(chatId, registration, portalLinkMatch[1] === 'new');
      return;
    }

    const changeDeviceMatch = data.match(/^changedevice:(phone|pc)$/);
    if (changeDeviceMatch) {
      this.peerRequests.set(chatId, {
        deviceType: changeDeviceMatch[1] === 'phone' ? PeerDeviceType.PHONE : PeerDeviceType.PC,
        explicitReissue: true,
      });
      await this.promptProtocolChoice(chatId);
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
      if (!request?.protocol && !request?.multiProtocol) {
        await this.notificationsService.sendToChat(chatId, 'Сессия запроса устарела, начните заново.');
        return;
      }
      await this.issuePeer(chatId, registration, organization, request, true);
    }
  }

  // Один доступный вариант сервера/моста (типичный случай) — пропускаем шаг выбора и сразу
  // создаём/проверяем перевыпуск; так же — если среди НЕСКОЛЬКИХ вариантов есть мост
  // "по умолчанию" (Bridge.isDefault, настраивается в панели) — используем именно его
  // молча, не спрашивая; иначе (несколько вариантов, default не задан или не входит в
  // список) — спрашиваем явно ("мост «X»"/"напрямую: Y").
  private async proceedAfterProtocol(
    chatId: string,
    registration: TelegramRegistration,
    organization: Organization,
    request: PeerRequest,
  ): Promise<void> {
    const options = request.multiProtocol
      ? await this.peersService.listMultiProtocolUpstreamOptions(organization)
      : await this.peersService.listUpstreamOptions(organization, request.protocol!);
    if (options.length === 0) {
      await this.notificationsService.sendToChat(chatId, 'Для вашей организации ещё не настроен доступ ни к одному серверу или мосту.');
      this.peerRequests.delete(chatId);
      return;
    }
    const defaultOption = options.find((option) => option.isDefault);
    if (options.length === 1 || defaultOption) {
      await this.confirmOrIssue(chatId, registration, organization, request, (defaultOption ?? options[0]).key);
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
    const hasExisting = existingPeers.some((peer) => peer.deviceType === request.deviceType);
    // Запрос со "Сменить протокол" уже спросил подтверждение неявно (сама кнопка означает
    // "заменить текущий конфиг") — не спрашивать второй раз.
    if (hasExisting && request.explicitReissue) {
      await this.issuePeer(chatId, registration, organization, request, true);
      return;
    }
    if (hasExisting) {
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
      const { filename, content } = request.multiProtocol
        ? reissue
          ? await this.peersService.reissueMultiProtocolForTelegramRegistration(registration, organization, request.deviceType, upstreamKey)
          : await this.peersService.createMultiProtocolForTelegramRegistration(registration, organization, request.deviceType, upstreamKey)
        : reissue
          ? await this.peersService.reissueForTelegramRegistration(registration, organization, request.protocol!, request.deviceType, upstreamKey)
          : await this.peersService.createForTelegramRegistration(registration, organization, request.protocol!, request.deviceType, upstreamKey);
      await this.notificationsService.sendDocumentToChat(chatId, filename, content);
      const png = await QRCode.toBuffer(content, { type: 'png', width: 400 });
      await this.notificationsService.sendPhotoToChat(chatId, png, 'QR-код для быстрого подключения');
      await this.log(
        LogLevel.INFO,
        `${reissue ? 'Перевыпущен' : 'Выдан'} peer «${filename.replace(/\.(conf|vpn)$/, '')}» (${request.multiProtocol ? 'мультиконфиг' : request.protocol}, ${request.deviceType})`,
        chatId,
      );
    } catch (error) {
      await this.log(LogLevel.ERROR, `Не удалось выдать peer: ${(error as Error).message}`, chatId);
      await this.notificationsService.sendToChat(chatId, `Не удалось создать конфиг: ${(error as Error).message}`);
    } finally {
      this.peerRequests.delete(chatId);
    }
  }

  // Вызывается TelegramRegistrationsService при подтверждении заявки суперадмином —
  // best-effort, неудачная отправка не должна блокировать само подтверждение.
  // chatId — null, если заявка заведена через веб-портал и Telegram ещё не привязан (см.
  // TelegramRegistration.webToken) — тогда уведомлять нечего, клиент узнаёт об одобрении
  // на странице портала.
  async notifyApproved(chatId: string | null): Promise<void> {
    if (!chatId) {
      return;
    }
    try {
      await this.notificationsService.sendToChat(chatId, 'Ваша регистрация подтверждена!');
      await this.sendMainMenu(chatId);
    } catch (error) {
      this.logger.warn(`Не удалось уведомить чат ${chatId} о подтверждении: ${(error as Error).message}`);
    }
  }
}
