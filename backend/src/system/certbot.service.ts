import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const execFileAsync = promisify(execFile);

// certbot запускается ПРЯМО в backend-контейнере (обычный child process, тот же execFile-
// идиома, что update.service.ts/backup.service.ts) — HTTP-01 webroot-режим не требует
// root/эксклюзивного порта, достаточно общей директории с nginx, отдельный sibling-
// контейнер тут избыточен. КРИТИЧНО: certbot по умолчанию хранит всё под /etc/letsencrypt
// внутри СВОЕГО контейнера — то есть внутри backend, невидимо для nginx (отдельный
// контейнер). Поэтому --config-dir/--work-dir/--logs-dir ЯВНО указывают на подкаталоги
// REPO_PATH — тот же самый путь, что смонтирован (read-write у backend, read-only у
// nginx) под /etc/letsencrypt в nginx.conf.template — вот как результат вообще становится
// видимым nginx.
@Injectable()
export class CertbotService {
  private readonly logger = new Logger(CertbotService.name);

  constructor(private readonly configService: ConfigService) {}

  private getRepoPath(): string {
    const repoPath = this.configService.get<string>('REPO_PATH');
    if (!repoPath) {
      throw new InternalServerErrorException('REPO_PATH не задан — HTTPS доступен только в деплое через docker-compose.yml');
    }
    return repoPath;
  }

  private dirs() {
    const repoPath = this.getRepoPath();
    return {
      webroot: path.join(repoPath, 'certbot', 'webroot'),
      configDir: path.join(repoPath, 'certbot', 'conf'),
      workDir: path.join(repoPath, 'certbot', 'work'),
      logsDir: path.join(repoPath, 'certbot', 'logs'),
    };
  }

  certPaths(domain: string): { fullchain: string; privkey: string } {
    const { configDir } = this.dirs();
    const liveDir = path.join(configDir, 'live', domain);
    return { fullchain: path.join(liveDir, 'fullchain.pem'), privkey: path.join(liveDir, 'privkey.pem') };
  }

  // Первичный выпуск (или перевыпуск при смене домена) — certonly, не renew: для домена,
  // на который ещё нет сохранённой renewal-конфигурации, renew ничего не сделает.
  async issue(domain: string, email: string): Promise<void> {
    const { webroot, configDir, workDir, logsDir } = this.dirs();
    await execFileAsync('certbot', [
      'certonly',
      '--webroot',
      '-w',
      webroot,
      '-d',
      domain,
      '--non-interactive',
      '--agree-tos',
      '-m',
      email,
      '--config-dir',
      configDir,
      '--work-dir',
      workDir,
      '--logs-dir',
      logsDir,
    ]);
  }

  // Обновление уже выпущенного сертификата — certbot сам решает, пора ли (no-op, если до
  // истечения ещё далеко), если не передан force. Используется и кнопкой "Обновить
  // сейчас" (force=true), и суточным cron (force=false).
  async renew(force = false): Promise<void> {
    const { webroot, configDir, workDir, logsDir } = this.dirs();
    await execFileAsync('certbot', [
      'renew',
      '--webroot',
      '-w',
      webroot,
      '--config-dir',
      configDir,
      '--work-dir',
      workDir,
      '--logs-dir',
      logsDir,
      '--quiet',
      ...(force ? ['--force-renewal'] : []),
    ]);
  }

  async readCertExpiry(domain: string): Promise<Date | null> {
    const { fullchain } = this.certPaths(domain);
    try {
      const { stdout } = await execFileAsync('openssl', ['x509', '-enddate', '-noout', '-in', fullchain]);
      const match = stdout.match(/notAfter=(.+)/);
      if (!match) {
        return null;
      }
      const parsed = new Date(match[1].trim());
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch (error) {
      this.logger.debug(`Не удалось прочитать срок действия сертификата ${domain}: ${(error as Error).message}`);
      return null;
    }
  }
}
