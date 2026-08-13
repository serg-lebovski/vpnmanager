import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { decryptSecret } from '../common/encryption.util';
import { SystemSettings } from '../system/system-settings.entity';

// Никакого нового HTTP-клиента в зависимостях — Node 20 (см. backend/Dockerfile) уже
// несёт глобальный fetch.
const TELEGRAM_API_TIMEOUT_MS = 10_000;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectRepository(SystemSettings) private readonly settingsRepository: Repository<SystemSettings>) {}

  // Молча ничего не делает, если Telegram не настроен/выключен — вызывающий код (проверки
  // истечения peer'ов, ошибка обновления сертификата и т.п.) не должен знать/проверять
  // это сам. Если telegramBridgeId настроен — сообщение уйдёт через маршрут этого моста
  // (см. VpnProvisioningService.setupTelegramRouting, настраивается один раз в
  // SettingsService.update, здесь ничего для этого делать не нужно — маршрутизация
  // прозрачна на уровне ядра self-сервера).
  async sendMessage(text: string): Promise<void> {
    const settings = await this.settingsRepository.findOne({ where: { id: 1 } });
    if (!settings?.telegramEnabled || !settings.telegramBotTokenEnc || !settings.telegramChatId) {
      return;
    }
    try {
      await this.deliver(settings.telegramBotTokenEnc, settings.telegramChatId, text);
    } catch (error) {
      this.logger.warn(`Не удалось отправить уведомление в Telegram: ${(error as Error).message}`);
    }
  }

  // В отличие от sendMessage (best-effort — не должен ронять посторонний код вроде
  // проверки истечения peer'ов), кнопка "Отправить тестовое сообщение" в Настройках
  // ДОЛЖНА показать реальную причину сбоя — иначе она всегда отвечает "успех", даже если
  // Telegram ничего не принял (поймано вживую: неверный токен бота без части id: — 404 от
  // Telegram — тихо проглатывался, и пользователь не понимал, почему сообщение не пришло).
  async sendTestMessage(text: string): Promise<void> {
    const settings = await this.settingsRepository.findOne({ where: { id: 1 } });
    if (!settings?.telegramBotTokenEnc || !settings.telegramChatId) {
      throw new Error('Токен бота или chat id не настроены');
    }
    await this.deliver(settings.telegramBotTokenEnc, settings.telegramChatId, text);
  }

  private async deliver(tokenEnc: string, chatId: string, text: string): Promise<void> {
    const token = decryptSecret(tokenEnc);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Telegram API вернул ошибку ${response.status}: ${await response.text()}`);
    }
  }

  // Расшифрованный токен бота — используется TelegramBotService для long-polling
  // getUpdates (тот же бот, что и для алертов, отдельного токена не заводим). null, если
  // бот ещё не настроен в Настройках — поллер сам пропускает тик, ничего не бросая.
  async getDecryptedBotToken(): Promise<string | null> {
    const settings = await this.settingsRepository.findOne({ where: { id: 1 } });
    if (!settings?.telegramBotTokenEnc) {
      return null;
    }
    return decryptSecret(settings.telegramBotTokenEnc);
  }

  // Приветствие для тех, кто впервые пишет боту /start — редактируется в Настройках
  // Telegram-бота; свой дефолт здесь, а не в БД, чтобы не хранить один и тот же текст
  // дважды (в схеме и в коде).
  async getWelcomeMessage(): Promise<string> {
    const settings = await this.settingsRepository.findOne({ where: { id: 1 } });
    return settings?.telegramWelcomeMessage?.trim() || 'Добро пожаловать! Этот бот поможет вам получить доступ к VPN.';
  }

  // Текст по кнопке "ℹ️ Информация" — целиком на усмотрение администратора, поэтому дефолт
  // честно говорит, что текст ещё не задан, а не выдумывает содержание за суперадмина.
  async getInfoMessage(): Promise<string> {
    const settings = await this.settingsRepository.findOne({ where: { id: 1 } });
    return settings?.telegramInfoMessage?.trim() || 'Дополнительная информация пока не добавлена администратором.';
  }

  // Отправка в ПРОИЗВОЛЬНЫЙ чат (не фиксированный telegramChatId настроек) — используется
  // ботом самостоятельной регистрации (telegram-bot/) для ответов конкретным
  // пользователям и для рассылки. В отличие от sendMessage — бросает ошибку наружу,
  // вызывающий код сам решает, best-effort это или нет (рассылка, например, ловит ошибку
  // на каждого получателя отдельно, чтобы один заблокировавший бота не сорвал остальных).
  // Возвращает message_id отправленного сообщения — нужен рассылке (telegram-bot/), чтобы
  // потом иметь возможность закрепить/удалить именно это сообщение в конкретном чате.
  async sendToChat(chatId: string, text: string, replyMarkup?: unknown): Promise<number> {
    const token = await this.requireBotToken();
    const body = await this.post(token, 'sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });
    return (body as { result: { message_id: number } }).result.message_id;
  }

  // disable_notification — закрепление не должно ещё раз пинговать пользователя, он уже
  // получил уведомление о самом сообщении.
  async pinChatMessage(chatId: string, messageId: number): Promise<void> {
    const token = await this.requireBotToken();
    await this.post(token, 'pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  // Используется при удалении сохранённой рассылки (TelegramRegistrationsService) — снимает
  // сообщение из ЧАТА КОНКРЕТНОГО получателя, не только из истории на нашей стороне.
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    const token = await this.requireBotToken();
    await this.post(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  // Убирает "часики" на нажатой inline-кнопке в клиенте Telegram — best-effort, не должно
  // ронять обработку самого нажатия, если бот на секунду не успел ответить вовремя.
  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    try {
      const token = await this.requireBotToken();
      await this.post(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId });
    } catch (error) {
      this.logger.warn(`Не удалось ответить на callback_query: ${(error as Error).message}`);
    }
  }

  // Текстовый файл как документ (клиентский .conf) — Telegram Bot API требует multipart
  // для файлов, JSON (как в deliver/sendToChat) годится только для текста.
  async sendDocumentToChat(chatId: string, filename: string, content: string): Promise<void> {
    const token = await this.requireBotToken();
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([content], { type: 'text/plain' }), filename);
    await this.postForm(token, 'sendDocument', form);
  }

  // mimeType/filename — по умолчанию под исходный случай использования (QR-код, всегда
  // PNG); картинки новостей/инструкций (TelegramBotService.sendContentFeed) приходят от
  // администратора в произвольном формате, передают его явно.
  async sendPhotoToChat(chatId: string, image: Buffer, caption?: string, mimeType = 'image/png', filename = 'photo.png'): Promise<void> {
    const token = await this.requireBotToken();
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) {
      form.append('caption', caption);
    }
    form.append('photo', new Blob([new Uint8Array(image)], { type: mimeType }), filename);
    await this.postForm(token, 'sendPhoto', form);
  }

  // @username бота — для deep-link веб-портала (t.me/<username>?start=<webToken>, см.
  // TelegramPortalService/PortalPage.tsx). Не кэшируется (страница портала открывается
  // нечасто, а смена токена бота должна отражаться сразу, без рестарта) — null, если бот не
  // настроен или Telegram API недоступен, вызывающий код просто не показывает кнопку.
  async getBotUsername(): Promise<string | null> {
    const token = await this.getDecryptedBotToken();
    if (!token) {
      return null;
    }
    try {
      const body = (await this.post(token, 'getMe', {})) as { result: { username: string } };
      return body.result.username;
    } catch (error) {
      this.logger.warn(`Не удалось определить username бота: ${(error as Error).message}`);
      return null;
    }
  }

  private async requireBotToken(): Promise<string> {
    const token = await this.getDecryptedBotToken();
    if (!token) {
      throw new Error('Токен Telegram-бота не настроен');
    }
    return token;
  }

  private async post(token: string, method: string, body: unknown): Promise<unknown> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Telegram API вернул ошибку ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  private async postForm(token: string, method: string, form: FormData): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Telegram API вернул ошибку ${response.status}: ${await response.text()}`);
    }
  }
}
