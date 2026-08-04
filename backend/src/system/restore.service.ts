import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemGateway } from './system.gateway';

const execFileAsync = promisify(execFile);

// Восстанавливает БД из загруженного дампа (см. backup.service.ts — pg_dump без
// --clean/--if-exists, поэтому DROP SCHEMA перед восстановлением ОБЯЗАТЕЛЕН, иначе
// psql -f упал бы на первом же CREATE TABLE против непустой схемы). Максимально
// разрушительная операция — полная замена текущей БД содержимым дампа, необратимо.
@Injectable()
export class RestoreService {
  private readonly logger = new Logger(RestoreService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly systemGateway: SystemGateway,
  ) {}

  // Fire-and-forget, аналогично UpdateService.triggerUpdate() — восстановление вот-вот
  // оборвёт то самое соединение с БД, которое обслуживает ЭТОТ ЖЕ HTTP-запрос, поэтому
  // ждать его тем же запросом бессмысленно. Прогресс — через SystemGateway (WebSocket).
  triggerRestore(uploadedFilePath: string): void {
    this.runRestoreSequence(uploadedFilePath).catch((error) => {
      this.logger.error(`Восстановление завершилось с ошибкой: ${(error as Error).message}`);
    });
  }

  private dbConnection() {
    return {
      host: this.configService.getOrThrow<string>('DB_HOST'),
      port: this.configService.get<number>('DB_PORT', 5432),
      user: this.configService.getOrThrow<string>('DB_USER'),
      password: this.configService.getOrThrow<string>('DB_PASSWORD'),
      database: this.configService.getOrThrow<string>('DB_NAME'),
    };
  }

  private async runRestoreSequence(uploadedFilePath: string): Promise<void> {
    const emit = (percent: number, step: string) => this.systemGateway.broadcastRestoreProgress({ percent, step, done: false });
    const { host, port, user, password, database } = this.dbConnection();
    const psqlArgs = ['-h', host, '-p', String(port), '-U', user, '-d', database];
    const env = { ...process.env, PGPASSWORD: password };

    try {
      emit(10, 'Приём файла');

      // У приложения несколько всегда работающих в фоне поллеров (DashboardService
      // каждые 7с, BridgesService/BridgeFailoverService и т.п.) — они гонялись бы за
      // DROP SCHEMA, если не оборвать текущие соединения с БД заранее.
      emit(25, 'Отключение текущих соединений с БД');
      await execFileAsync('psql', [
        ...psqlArgs,
        '-c',
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();',
      ], { env });

      emit(45, 'Очистка схемы');
      await execFileAsync('psql', [...psqlArgs, '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { env });

      emit(65, 'Восстановление дампа');
      await execFileAsync('psql', [...psqlArgs, '-f', uploadedFilePath], { env });

      this.systemGateway.broadcastRestoreProgress({ percent: 100, step: 'Готово — backend перезапускается', done: true });

      // Свежий пул соединений TypeORM и чистое in-memory состояние поллеров — намеренно
      // НЕ sibling-container паттерн из update.service.ts (тот нужен для пересоздания
      // КОНТЕЙНЕРА при смене образа при самообновлении; здесь ни образ, ни identity
      // контейнера не меняются — обычный restart: unless-stopped уже даёт чистый рестарт
      // процесса, без какого-либо участия docker.sock).
      setTimeout(() => process.exit(0), 500);
    } catch (error) {
      this.systemGateway.broadcastRestoreProgress({
        percent: 100,
        step: 'Ошибка',
        done: true,
        error: (error as Error).message,
      });
      throw error;
    } finally {
      fs.unlink(uploadedFilePath, () => {
        // best-effort — временный файл в os.tmpdir(), не критично, если не удалился.
      });
    }
  }
}
