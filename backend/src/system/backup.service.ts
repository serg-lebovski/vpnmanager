import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { Response } from 'express';

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(private readonly configService: ConfigService) {}

  // Стримит pg_dump прямо в HTTP-ответ, не буферизуя дамп целиком в памяти процесса.
  // PGPASSWORD передаётся через env спавненного процесса, а не как аргумент CLI —
  // аргументы командной строки видны любому локальному пользователю через `ps`.
  streamDatabaseDump(res: Response): void {
    const host = this.configService.getOrThrow<string>('DB_HOST');
    const port = this.configService.get<number>('DB_PORT', 5432);
    const user = this.configService.getOrThrow<string>('DB_USER');
    const password = this.configService.getOrThrow<string>('DB_PASSWORD');
    const database = this.configService.getOrThrow<string>('DB_NAME');

    const filename = `vpnmanager-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const dump = spawn('pg_dump', ['-h', host, '-p', String(port), '-U', user, '-d', database, '--no-owner', '--no-privileges'], {
      env: { ...process.env, PGPASSWORD: password },
    });

    dump.stdout.pipe(res);

    let stderr = '';
    dump.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    dump.on('error', (error) => {
      this.logger.error(`pg_dump не запустился: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Не удалось запустить pg_dump на сервере' });
      } else {
        res.destroy();
      }
    });

    dump.on('close', (code) => {
      if (code !== 0) {
        this.logger.error(`pg_dump завершился с кодом ${code}: ${stderr}`);
        if (!res.headersSent) {
          res.status(500).json({ message: 'pg_dump завершился с ошибкой' });
        } else {
          res.destroy();
        }
      }
    });
  }
}
