import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntry } from './audit-log-entry.entity';

const SENSITIVE_KEYS = new Set(['password', 'newPassword', 'secret', 'privateKey', 'confirmationPhrase']);

export interface RecordAuditLogInput {
  actorUserId: string | null;
  actorEmail: string | null;
  method: string;
  path: string;
  targetId: string | null;
  body: unknown;
  statusCode: number;
  ipAddress: string | null;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(@InjectRepository(AuditLogEntry) private readonly repository: Repository<AuditLogEntry>) {}

  // Рекурсивно вырезает пароли/секреты из тела запроса ПЕРЕД сохранением — журнал действий
  // не должен стать ещё одним местом, где лежит расшифрованный секрет (SSH-пароль сервера,
  // пароль пользователя и т.п.).
  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = SENSITIVE_KEYS.has(key) ? '[скрыто]' : this.redact(val);
      }
      return result;
    }
    return value;
  }

  // Best-effort — падение записи в журнал не должно ронять сам запрос пользователя,
  // поэтому вызывающий код (AuditLogInterceptor) не ждёт/не пробрасывает ошибку отсюда.
  async record(input: RecordAuditLogInput): Promise<void> {
    try {
      const body = input.body && typeof input.body === 'object' && Object.keys(input.body as object).length > 0 ? (this.redact(input.body) as Record<string, unknown>) : null;
      await this.repository.save(this.repository.create({ ...input, body }));
    } catch (error) {
      this.logger.warn(`Не удалось записать событие в журнал действий: ${(error as Error).message}`);
    }
  }

  async findRecent(limit = 200): Promise<AuditLogEntry[]> {
    return this.repository.find({ order: { createdAt: 'DESC' }, take: Math.min(Math.max(1, limit), 500) });
  }
}
