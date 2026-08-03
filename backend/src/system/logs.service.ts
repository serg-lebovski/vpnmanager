import { execFile } from 'child_process';
import { promisify } from 'util';
import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const execFileAsync = promisify(execFile);

// Те же 4 сервиса, что в docker-compose.yml — белый список, не пробрасываем сюда
// произвольное имя сервиса из запроса.
const ALLOWED_SERVICES = ['backend', 'frontend', 'nginx', 'postgres'] as const;
export type LogService = (typeof ALLOWED_SERVICES)[number];

const MAX_TAIL_LINES = 5000;

@Injectable()
export class LogsService {
  constructor(private readonly configService: ConfigService) {}

  private getRepoPath(): string {
    const repoPath = this.configService.get<string>('REPO_PATH');
    if (!repoPath) {
      throw new InternalServerErrorException(
        'REPO_PATH не задан — просмотр логов доступен только в деплое через docker-compose.yml',
      );
    }
    return repoPath;
  }

  // Читает логи контейнера через `docker compose logs` — тот же docker.sock, что уже
  // смонтирован для самообновления (см. update.service.ts), отдельного доступа не нужно.
  async getLogs(service: string, tail: number): Promise<string> {
    if (!ALLOWED_SERVICES.includes(service as LogService)) {
      throw new BadRequestException(`Неизвестный сервис "${service}" — допустимо: ${ALLOWED_SERVICES.join(', ')}`);
    }
    const repoPath = this.getRepoPath();
    const safeTail = Math.min(Math.max(1, Math.trunc(tail) || 200), MAX_TAIL_LINES);

    const { stdout } = await execFileAsync(
      'docker',
      ['compose', 'logs', service, '--no-color', '--timestamps', '--tail', String(safeTail)],
      { cwd: repoPath, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  }
}
