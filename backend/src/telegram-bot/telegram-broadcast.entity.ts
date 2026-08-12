import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export interface TelegramBroadcastDelivery {
  chatId: string;
  messageId: number;
}

// История рассылок суперадмина всем подтверждённым Telegram-пользователям (см.
// TelegramRegistrationsService.broadcast) — хранит не только текст, но и per-получателя
// (chat_id, message_id), иначе удалить/открепить уже отправленное сообщение у конкретных
// людей было бы нечем (Telegram Bot API требует message_id именно ИЗ ЧАТА получателя).
@Entity('telegram_broadcasts')
export class TelegramBroadcast {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  text: string;

  @Column({ default: false })
  pinned: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  deliveries: TelegramBroadcastDelivery[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
