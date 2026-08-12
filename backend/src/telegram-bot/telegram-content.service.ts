import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramContentKind } from '../common/enums';
import { CreateTelegramContentDto } from './dto/create-telegram-content.dto';
import { TelegramContentPost } from './telegram-content-post.entity';

@Injectable()
export class TelegramContentService {
  constructor(@InjectRepository(TelegramContentPost) private readonly repository: Repository<TelegramContentPost>) {}

  async list(kind: TelegramContentKind): Promise<TelegramContentPost[]> {
    return this.repository.find({ where: { kind }, order: { createdAt: 'DESC' } });
  }

  async create(kind: TelegramContentKind, dto: CreateTelegramContentDto): Promise<TelegramContentPost> {
    const post = this.repository.create({ kind, title: dto.title?.trim() || null, body: dto.body, images: dto.images ?? [] });
    return this.repository.save(post);
  }

  async remove(id: string): Promise<void> {
    const post = await this.repository.findOne({ where: { id } });
    if (!post) {
      throw new NotFoundException('Запись не найдена');
    }
    await this.repository.remove(post);
  }

  // Для бота: новости — последние limit штук в порядке публикации (старые сначала, чтобы
  // самая свежая оказалась внизу чата, ближе к полю ввода); инструкции — все целиком, тоже
  // в порядке публикации (их обычно немного, лимит не нужен).
  async listForBot(kind: TelegramContentKind, limit?: number): Promise<TelegramContentPost[]> {
    const posts = await this.repository.find({ where: { kind }, order: { createdAt: 'DESC' }, take: limit });
    return posts.reverse();
  }
}
