import * as fs from 'fs';
import * as path from 'path';
import { Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { reloadNginx } from '../common/docker.util';
import { CertbotService } from './certbot.service';
import { SystemSettings } from './system-settings.entity';

type RenderSettings = Pick<SystemSettings, 'domain' | 'httpEnabled' | 'httpsEnabled'>;

// Собирает nginx/generated/default.conf (git-tracked один раз с безопасным HTTP-only
// дефолтом, дальше НИКОГДА не редактируется вручную и не трогается будущими коммитами —
// поэтому перезаписанный здесь локальный вариант никогда не конфликтует с `git pull`, см.
// update.service.ts) из nginx/nginx.conf.template (общие /api/, /socket.io/, / локации —
// не меняются) + текущих SystemSettings (домен/HTTP/HTTPS/сертификат).
//
// Инвариант безопасности: слушать 443 с ssl_certificate начинаем ТОЛЬКО если файлы
// сертификата реально существуют на диске — независимо от того, что говорит
// httpsEnabled в БД. Рассинхрон (httpsEnabled=true, но файла нет) не ломает панель —
// тихо остаёмся на HTTP, а расхождение видно через lastCertError на фронтенде.
//
// Читает SystemSettings через репозиторий напрямую, а не через SettingsService — тот
// сам зависит от NginxConfigService (вызывает render() после любого изменения настроек),
// инжект в обратную сторону создал бы DI-цикл.
@Injectable()
export class NginxConfigService implements OnModuleInit {
  private readonly logger = new Logger(NginxConfigService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly certbotService: CertbotService,
    @InjectRepository(SystemSettings) private readonly settingsRepository: Repository<SystemSettings>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.render();
    } catch (error) {
      this.logger.error(`Не удалось отрендерить nginx-конфиг при старте: ${(error as Error).message}`);
    }
  }

  private getRepoPath(): string {
    const repoPath = this.configService.get<string>('REPO_PATH');
    if (!repoPath) {
      throw new InternalServerErrorException('REPO_PATH не задан');
    }
    return repoPath;
  }

  async render(settings?: RenderSettings): Promise<void> {
    const repoPath = this.getRepoPath();
    const resolved = settings ?? (await this.loadCurrentSettings());
    const sharedLocations = fs.readFileSync(path.join(repoPath, 'nginx', 'nginx.conf.template'), 'utf8');

    const hasCert = Boolean(resolved.domain) && fs.existsSync(this.certbotService.certPaths(resolved.domain!).fullchain);
    const serveHttps = resolved.httpsEnabled && hasCert;
    if (resolved.httpsEnabled && !hasCert) {
      this.logger.warn('HTTPS включён в настройках, но сертификат ещё не найден на диске — обслуживаю только HTTP');
    }

    let config: string;
    if (serveHttps) {
      // ВАЖНО: здесь нужны пути так, как их видит КОНТЕЙНЕР NGINX (смонтирован
      // ./certbot/conf:/etc/letsencrypt:ro в docker-compose.yml), а НЕ
      // certbotService.certPaths() — тот возвращает путь так, как его видит backend
      // (${REPO_PATH}/certbot/conf/..., через бланковый ${PWD}:${PWD}), у nginx такого
      // пути в файловой системе просто нет (поймано вживую при первом живом тесте —
      // "cannot load certificate ... No such file or directory").
      const fullchain = `/etc/letsencrypt/live/${resolved.domain}/fullchain.pem`;
      const privkey = `/etc/letsencrypt/live/${resolved.domain}/privkey.pem`;
      const port80Body = resolved.httpEnabled
        ? `    location / {\n        return 301 https://$host$request_uri;\n    }\n`
        : `    location / {\n        return 404;\n    }\n`;
      config =
        `server {\n    listen 80;\n    server_name ${resolved.domain};\n\n` +
        `    location /.well-known/acme-challenge/ {\n        root /var/www/certbot;\n    }\n\n` +
        `${port80Body}}\n\n` +
        `server {\n    listen 443 ssl;\n    server_name ${resolved.domain};\n\n` +
        `    ssl_certificate ${fullchain};\n    ssl_certificate_key ${privkey};\n\n` +
        `${sharedLocations}}\n`;
    } else {
      // Домен задан, но сертификата ещё нет — это либо первый выпуск (certbot вот-вот
      // запросит challenge через ЭТОТ же location), либо HTTPS выключен вовсе; в обоих
      // случаях безопасно отдавать acme-challenge, если домен задан.
      const acmeLocation = resolved.domain
        ? `    location /.well-known/acme-challenge/ {\n        root /var/www/certbot;\n    }\n\n`
        : '';
      config = `server {\n    listen 80;\n    server_name _;\n\n${acmeLocation}${sharedLocations}}\n`;
    }

    fs.writeFileSync(path.join(repoPath, 'nginx', 'generated', 'default.conf'), config);
    await reloadNginx();
  }

  private async loadCurrentSettings(): Promise<RenderSettings> {
    const row = await this.settingsRepository.findOne({ where: { id: 1 } });
    return row ?? { domain: null, httpEnabled: true, httpsEnabled: false };
  }
}
