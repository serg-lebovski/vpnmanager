import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramRegistrationStatus } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { PeersService } from '../peers/peers.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramRegistration } from './telegram-registration.entity';

export interface TelegramRegistrationListItem {
  id: string;
  telegramChatId: string;
  telegramUsername: string | null;
  organizationId: string;
  organizationName: string;
  fullName: string;
  status: TelegramRegistrationStatus;
  createdAt: Date;
}

@Injectable()
export class TelegramRegistrationsService {
  private readonly logger = new Logger(TelegramRegistrationsService.name);

  constructor(
    @InjectRepository(TelegramRegistration) private readonly registrationsRepository: Repository<TelegramRegistration>,
    private readonly peersService: PeersService,
    private readonly notificationsService: NotificationsService,
    private readonly telegramBotService: TelegramBotService,
  ) {}

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

  async approve(id: string): Promise<void> {
    const registration = await this.registrationsRepository.findOne({ where: { id } });
    if (!registration) {
      throw new NotFoundException('Заявка не найдена');
    }
    registration.status = TelegramRegistrationStatus.APPROVED;
    await this.registrationsRepository.save(registration);
    await this.telegramBotService.notifyApproved(registration.telegramChatId);
  }

  // Отзывает все peers регистрации на сервере (не полагается только на ON DELETE SET NULL —
  // иначе peer остался бы активным на upstream/self-сервере осиротевшим) и затем удаляет
  // саму заявку.
  async remove(id: string): Promise<void> {
    const registration = await this.registrationsRepository.findOne({ where: { id } });
    if (!registration) {
      throw new NotFoundException('Заявка не найдена');
    }
    await this.peersService.revokeAllPeersForTelegramRegistration(id);
    await this.registrationsRepository.remove(registration);
  }

  // Best-effort по каждому получателю отдельно — один заблокировавший бота пользователь не
  // должен обрывать рассылку остальным подтверждённым.
  async broadcast(text: string): Promise<{ sent: number; failed: number }> {
    const approved = await this.registrationsRepository.find({ where: { status: TelegramRegistrationStatus.APPROVED } });
    let sent = 0;
    let failed = 0;
    for (const registration of approved) {
      try {
        await this.notificationsService.sendToChat(registration.telegramChatId, text);
        sent++;
      } catch (error) {
        failed++;
        this.logger.warn(`Не удалось отправить рассылку чату ${registration.telegramChatId}: ${(error as Error).message}`);
      }
    }
    return { sent, failed };
  }
}
