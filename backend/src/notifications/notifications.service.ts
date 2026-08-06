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
      const token = decryptSecret(settings.telegramBotTokenEnc);
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.telegramChatId, text }),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Telegram API вернул ошибку (${response.status}): ${await response.text()}`);
      }
    } catch (error) {
      this.logger.warn(`Не удалось отправить уведомление в Telegram: ${(error as Error).message}`);
    }
  }
}
