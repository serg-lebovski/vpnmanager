import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, Not, Repository } from 'typeorm';
import { LogLevel, TelegramRegistrationStatus } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { PeersService } from '../peers/peers.service';
import { TelegramBotLog } from './telegram-bot-log.entity';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramBroadcast, TelegramBroadcastDelivery } from './telegram-broadcast.entity';
import { TelegramRegistration } from './telegram-registration.entity';

export interface TelegramRegistrationListItem {
  id: string;
  telegramChatId: string | null;
  telegramUsername: string | null;
  organizationId: string;
  organizationName: string;
  fullName: string;
  status: TelegramRegistrationStatus;
  createdAt: Date;
}

export interface TelegramBroadcastListItem {
  id: string;
  text: string;
  pinned: boolean;
  recipientCount: number;
  createdAt: Date;
}

@Injectable()
export class TelegramRegistrationsService {
  private readonly logger = new Logger(TelegramRegistrationsService.name);

  constructor(
    @InjectRepository(TelegramRegistration) private readonly registrationsRepository: Repository<TelegramRegistration>,
    @InjectRepository(TelegramBroadcast) private readonly broadcastsRepository: Repository<TelegramBroadcast>,
    @InjectRepository(TelegramBotLog) private readonly logsRepository: Repository<TelegramBotLog>,
    private readonly peersService: PeersService,
    private readonly notificationsService: NotificationsService,
    private readonly telegramBotService: TelegramBotService,
  ) {}

  async listLogs(limit = 200): Promise<TelegramBotLog[]> {
    return this.logsRepository.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  async findAll(): Promise<TelegramRegistrationListItem[]> {
    const registrations = await this.registrationsRepository.find({
      relations: ['organization'],
      order: { createdAt: 'DESC' },
    });
    return registrations.map((r) => ({
      id: r.id,
      telegramChatId: r.telegramChatId,
      telegramUsername: r.telegramUsername,
      organizationId: r.organizationId,
      organizationName: r.organization.name,
      fullName: r.fullName,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  // Персональная ссылка веб-портала (/portal/<token>) для заявок без доступа к Telegram —
  // ленивая генерация: заявки, заведённые ДО появления этой функции, токена ещё не имеют
  // (см. TelegramRegistration.webToken), получают его по первому запросу отсюда.
  async getPortalLink(id: string): Promise<{ webToken: string }> {
    const registration = await this.registrationsRepository.findOne({ where: { id } });
    if (!registration) {
      throw new NotFoundException('Заявка не найдена');
    }
    if (!registration.webToken) {
      registration.webToken = randomUUID();
      await this.registrationsRepository.save(registration);
    }
    return { webToken: registration.webToken };
  }

  async approve(id: string): Promise<void> {
    const registration = await this.registrationsRepository.findOne({ where: { id } });
    if (!registration) {
      throw new NotFoundException('Заявка не найдена');
    }
    registration.status = TelegramRegistrationStatus.APPROVED;
    await this.registrationsRepository.save(registration);
    await this.logsRepository.insert({
      level: LogLevel.INFO,
      message: `Заявка подтверждена суперадмином: ${registration.fullName}`,
      chatId: registration.telegramChatId,
    });
    await this.telegramBotService.notifyApproved(registration.telegramChatId);
  }

  // revokePeers=true (по умолчанию): отзывает все peers регистрации на сервере (не
  // полагается только на ON DELETE SET NULL — иначе peer остался бы активным на
  // upstream/self-сервере осиротевшим) и затем удаляет саму заявку. revokePeers=false —
  // явный выбор суперадмина оставить уже выданные peers работать как обычные (просто
  // теряют привязку к заявке через ON DELETE SET NULL на Peer.telegramRegistrationId).
  async remove(id: string, revokePeers: boolean): Promise<void> {
    const registration = await this.registrationsRepository.findOne({ where: { id } });
    if (!registration) {
      throw new NotFoundException('Заявка не найдена');
    }
    if (revokePeers) {
      await this.peersService.revokeAllPeersForTelegramRegistration(id);
    }
    await this.logsRepository.insert({
      level: LogLevel.INFO,
      message: `Заявка удалена суперадмином: ${registration.fullName} (peers ${revokePeers ? 'отозваны' : 'оставлены'})`,
      chatId: registration.telegramChatId,
    });
    await this.registrationsRepository.remove(registration);
  }

  // Best-effort по каждому получателю отдельно — один заблокировавший бота пользователь не
  // должен обрывать рассылку остальным подтверждённым. Закрепление (pin) — тоже best-effort
  // на получателя: неудачный pin не должен считаться неудачной доставкой сообщения. Каждая
  // успешная доставка (chat_id+message_id) сохраняется в TelegramBroadcast.deliveries — без
  // этого удалить/открепить уже отправленное позже было бы нечем.
  async broadcast(text: string, pin: boolean): Promise<{ sent: number; failed: number }> {
    // Рассылка — только Telegram; заявки, заведённые через веб-портал и ещё не привязавшие
    // чат (telegramChatId IS NULL), физически некуда отправлять — не считаем их ни sent,
    // ни failed, они просто не участвуют.
    const approved = await this.registrationsRepository.find({
      where: { status: TelegramRegistrationStatus.APPROVED, telegramChatId: Not(IsNull()) },
    });
    const deliveries: TelegramBroadcastDelivery[] = [];
    let sent = 0;
    let failed = 0;
    for (const registration of approved) {
      const chatId = registration.telegramChatId!;
      try {
        const messageId = await this.notificationsService.sendToChat(chatId, text);
        deliveries.push({ chatId, messageId });
        sent++;
        if (pin) {
          try {
            await this.notificationsService.pinChatMessage(chatId, messageId);
          } catch (error) {
            this.logger.warn(`Не удалось закрепить сообщение в чате ${chatId}: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        failed++;
        this.logger.warn(`Не удалось отправить рассылку чату ${chatId}: ${(error as Error).message}`);
      }
    }
    const broadcast = this.broadcastsRepository.create({ text, pinned: pin, deliveries });
    await this.broadcastsRepository.save(broadcast);
    return { sent, failed };
  }

  async listBroadcasts(): Promise<TelegramBroadcastListItem[]> {
    const broadcasts = await this.broadcastsRepository.find({ order: { createdAt: 'DESC' } });
    return broadcasts.map((b) => ({
      id: b.id,
      text: b.text,
      pinned: b.pinned,
      recipientCount: b.deliveries.length,
      createdAt: b.createdAt,
    }));
  }

  // Снимает сообщение из чата КАЖДОГО получателя (не только запись из своей истории) —
  // best-effort на получателя: получатель мог сам удалить чат с ботом или заблокировать
  // его, это не должно мешать удалить остальным и саму запись рассылки.
  async deleteBroadcast(id: string): Promise<void> {
    const broadcast = await this.broadcastsRepository.findOne({ where: { id } });
    if (!broadcast) {
      throw new NotFoundException('Рассылка не найдена');
    }
    for (const delivery of broadcast.deliveries) {
      try {
        await this.notificationsService.deleteMessage(delivery.chatId, delivery.messageId);
      } catch (error) {
        this.logger.warn(`Не удалось удалить сообщение рассылки в чате ${delivery.chatId}: ${(error as Error).message}`);
      }
    }
    await this.broadcastsRepository.remove(broadcast);
  }
}
