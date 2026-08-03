import { execFile, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const execFileAsync = promisify(execFile);

export interface VersionInfo {
  currentCommit: string;
  currentCommitShort: string;
  remoteCommit: string | null;
  remoteCommitShort: string | null;
  updateAvailable: boolean;
  checkedAt: string;
}

// Самообновление по git + `docker compose up -d --build`, запускаемое ИЗНУТРИ backend-
// контейнера через сокет docker-демона хоста (docker-compose.yml монтирует
// /var/run/docker.sock и сам репозиторий по пути REPO_PATH — тому же самому, что и на
// хосте, через `${PWD}:${PWD}`). Это осознанный, явно выбранный компромисс безопасности:
// доступ к docker-сокету из контейнера равносилен root на хосте. Эндпоинты закрыты
// @Roles(SUPER_ADMIN); больше никаких пользовательских данных в запускаемые команды не
// подставляется — REPO_PATH берётся только из переменной окружения, заданной при деплое.
@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);

  constructor(private readonly configService: ConfigService) {}

  private getRepoPath(): string {
    const repoPath = this.configService.get<string>('REPO_PATH');
    if (!repoPath) {
      throw new InternalServerErrorException(
        'REPO_PATH не задан — самообновление доступно только в деплое через docker-compose.yml (см. volumes/environment у сервиса backend)',
      );
    }
    return repoPath;
  }

  async getVersion(): Promise<VersionInfo> {
    const repoPath = this.getRepoPath();
    const currentCommit = await this.git(repoPath, ['rev-parse', 'HEAD']);

    let remoteCommit: string | null = null;
    try {
      await this.git(repoPath, ['fetch', '--quiet', 'origin']);
      remoteCommit = await this.git(repoPath, ['rev-parse', 'origin/main']);
    } catch (error) {
      this.logger.warn(`Не удалось проверить обновления на GitHub: ${(error as Error).message}`);
    }

    return {
      currentCommit,
      currentCommitShort: currentCommit.slice(0, 8),
      remoteCommit,
      remoteCommitShort: remoteCommit?.slice(0, 8) ?? null,
      updateAvailable: remoteCommit !== null && remoteCommit !== currentCommit,
      checkedAt: new Date().toISOString(),
    };
  }

  // Запускает обновление в фоне и сразу возвращает управление — собственный контейнер
  // backend будет пересоздан в процессе `docker compose up -d --build`, поэтому ждать
  // завершения тем же HTTP-запросом бессмысленно (соединение оборвётся вместе с
  // контейнером). Вывод пишется в REPO_PATH/update.log на хосте — переживает
  // пересоздание контейнера, можно посмотреть по SSH после обновления.
  triggerUpdate(): { logFile: string } {
    const repoPath = this.getRepoPath();
    const logPath = path.join(repoPath, 'update.log');
    fs.appendFileSync(logPath, `\n--- Обновление запущено ${new Date().toISOString()} ---\n`);

    // --force-recreate — без него сервисы с бинд-маунтом ОТДЕЛЬНОГО ФАЙЛА (у нас так
    // смонтирован nginx.conf), чей образ не менялся, не пересоздаются на `up -d --build`
    // и остаются жить со СТАРЫМ содержимым: git pull заменяет файл на диске новым inode
    // (rename, не правка на месте), а bind-mount уже запущенного контейнера продолжает
    // указывать на прежний inode. Поймано вживую при первом деплое этой самой фичи.
    const child = exec(`git pull >> "${logPath}" 2>&1 && docker compose up -d --build --force-recreate >> "${logPath}" 2>&1`, {
      cwd: repoPath,
      env: { ...process.env, PWD: repoPath },
    });
    child.unref();

    return { logFile: logPath };
  }

  private async git(repoPath: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
    return stdout.trim();
  }
}
