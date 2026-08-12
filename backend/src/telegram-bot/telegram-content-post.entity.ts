import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TelegramContentKind } from '../common/enums';

// Новости и инструкции бота (кнопки «📰 Новости»/«📘 Инструкции») — одна сущность на оба
// вида контента (see TelegramContentKind): различаются только kind и тем, как их выдаёт бот
// (TelegramBotService.sendContentFeed — новости отдаёт последние N, инструкции все целиком).
@Entity('telegram_content_posts')
@Index(['kind', 'createdAt'])
export class TelegramContentPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: TelegramContentKind })
  kind: TelegramContentKind;

  @Column({ type: 'varchar', nullable: true })
  title: string | null;

  // Гиперссылки — просто http(s)-адрес прямо в тексте: Telegram сам подсвечивает и делает
  // кликабельным любой URL в обычном сообщении, без разметки/parse_mode и связанных с ним
  // рисков (экранирование пользовательского текста для HTML/Markdown).
  @Column({ type: 'text' })
  body: string;

  // data:-URI (data:image/...;base64,...) — тот же jsonb-массив-паттерн, что и
  // TelegramBroadcast.deliveries; отдельный файловый storage не заводим ради небольшого
  // числа картинок в новостях/инструкциях.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  images: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
