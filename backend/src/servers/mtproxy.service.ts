import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { NodeSSH } from 'node-ssh';
import { Repository } from 'typeorm';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { Server } from './server.entity';

// Диапазон заведомо не пересекается с типичными портами уже занятых сервисов на self-
// сервере (SSH, 80/443, backend/postgres в docker-сети, UDP-порты WG/AWG) — ss -ltn всё
// равно перепроверяет перед запуском, диапазон только сужает пространство перебора.
const PORT_RANGE_START = 20000;
const PORT_RANGE_SIZE = 10000;
const TLS_DOMAIN = 'www.google.com';
const ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UNIT_NAME = 'vpnmanager-mtproxy.service';

export interface MtProxyStatus {
  installed: boolean;
  server: string | null;
  port: number | null;
  secret: string | null;
  deepLink: string | null;
  updatedAt: Date | null;
}

// Постоянный MTProto-proxy на self-сервере — единственный способ помочь клиенту привязать
// Telegram (обязательное условие для выдачи конфигов через веб-портал, см.
// TelegramPortalService), если в его стране заблокирован сам Telegram: MTProto-proxy
// проксирует ИМЕННО трафик Telegram-клиента (не общий VPN), поэтому после его настройки
// клиент может открыть бота и пройти /start <token> как обычно. Ссылка на этот прокси
// показывается на портале регистрации автоматически, без действий со стороны клиента.
//
// Первая версия (история, отказались от неё 2026-08-15) создавала ОТДЕЛЬНУЮ временную
// сессию на 10 минут по запросу каждого клиента — но `nohup ... &` не отвязывал процесс
// от SSH-канала (см. живой инцидент в git-истории этого файла), а сама выдаваемая ссылка
// использовала неверный формат секрета (см. buildClientSecret ниже). Вместо этого теперь —
// ОДИН постоянный процесс под systemd (Restart=always переживает падение и перезагрузку
// хоста без какого-либо кода на стороне backend), устанавливаемый/переустанавливаемый
// кнопкой на карточке self-сервера (ServersPage) и с автоматической сменой ключа (не
// порта — уже разосланная ссылка должна продолжать резолвиться) раз в сутки.
@Injectable()
export class MtProxyService {
  private readonly logger = new Logger(MtProxyService.name);

  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    private readonly sshService: SshService,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

  async getStatus(serverId: string): Promise<MtProxyStatus> {
    const server = await this.findServerOrFail(serverId);
    return this.toStatus(server);
  }

  // Для портала регистрации (TelegramPortalService) — null, если self-сервер ещё не
  // определён или mtproxy на нём не установлен (тогда портал просто не показывает блок).
  async getSelfServerStatus(): Promise<MtProxyStatus | null> {
    const server = await this.serversRepository.findOne({ where: { isSelf: true } });
    if (!server) {
      return null;
    }
    const status = this.toStatus(server);
    return status.installed ? status : null;
  }

  // Кнопка «Создать/переустановить mtproxy» — устанавливает исходники (если их ещё нет),
  // выбирает свежие порт+секрет и (пере)разворачивает systemd-юнит. Каждый вызов полностью
  // перезаписывает config.py и рестартует тот же юнит — старый процесс не остаётся
  // висеть на старом порту, это осознанно ("переустановить" = начать с чистого состояния,
  // а не бережно сохранить прежний порт — в отличие от автоматической ежесуточной ротации
  // ключа, см. rotateSecrets).
  async install(serverId: string): Promise<MtProxyStatus> {
    const server = await this.findServerOrFail(serverId);
    if (!server.isSelf) {
      throw new BadRequestException(
        'mtproxy устанавливается только на self-сервер (тот же хост, на котором работает панель/мост)',
      );
    }
    const connection = this.vpnProvisioningService.connectionParams(server);
    const secret = randomBytes(16).toString('hex');

    const port = await this.sshService.withConnection(connection, async (ssh) => {
      await this.ensureProxySourceInstalled(ssh);
      const freePort = await this.findFreePort(ssh);
      await this.deployService(ssh, freePort, secret);
      return freePort;
    });

    server.mtProxyPort = port;
    server.mtProxySecretEnc = encryptSecret(secret);
    server.mtProxyUpdatedAt = new Date();
    await this.serversRepository.save(server);
    this.logger.log(`MTProto-proxy установлен на сервере "${server.name}" (порт ${port})`);
    return this.toStatus(server);
  }

  private async ensureProxySourceInstalled(ssh: NodeSSH): Promise<void> {
    await this.sshService.execOrThrow(
      ssh,
      `test -f /opt/mtproxy-src/mtprotoproxy.py || (apt-get update -y && apt-get install -y python3 git && ` +
        `rm -rf /opt/mtproxy-src && git clone --depth 1 https://github.com/alexbers/mtprotoproxy.git /opt/mtproxy-src)`,
    );
  }

  private async findFreePort(ssh: NodeSSH): Promise<number> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const candidate = PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
      const result = await this.sshService.exec(ssh, `ss -ltn | grep -q ":${candidate} " && echo BUSY || echo FREE`);
      if (result.stdout.trim() === 'FREE') {
        return candidate;
      }
    }
    throw new Error('Не удалось найти свободный порт на self-сервере для mtproxy');
  }

  // systemd, а не nohup/setsid-скрипт (как в первой, временной версии) — тут процесс должен
  // жить постоянно, а не 10 минут, поэтому нужен настоящий супервизор: Restart=always
  // переживает падение процесса и перезагрузку хоста без единой строчки кода в backend
  // (в отличие, например, от Telegram-роутинга через мост, которому для этого пришлось
  // заводить отдельный OnModuleInit — см. SettingsService).
  private async deployService(ssh: NodeSSH, port: number, secret: string): Promise<void> {
    const script = `cat > /opt/mtproxy-src/config.py <<'PYEOF'
PORT = ${port}
USERS = {
    "ephemeral": "${secret}",
}
MODES = {
    "classic": False,
    "secure": True,
    "tls": True,
}
TLS_DOMAIN = "${TLS_DOMAIN}"
PYEOF
cat > /etc/systemd/system/${UNIT_NAME} <<'UNITEOF'
[Unit]
Description=VPN Manager - MTProto proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mtproxy-src
ExecStart=/usr/bin/python3 /opt/mtproxy-src/mtprotoproxy.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF
command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active" && ufw allow ${port}/tcp || true
systemctl daemon-reload && systemctl enable --now ${UNIT_NAME} && systemctl restart ${UNIT_NAME}`;
    await this.sshService.execOrThrow(ssh, script);
  }

  // Раз в сутки — только секрет, порт и systemd-юнит не трогаем (уже разосланная клиентам
  // ссылка должна продолжать резолвиться на тот же порт, меняется только ключ — именно так,
  // как попросил пользователь).
  @Interval(ROTATE_INTERVAL_MS)
  async rotateSecrets(): Promise<void> {
    const servers = await this.serversRepository.find({ where: { isSelf: true } });
    for (const server of servers) {
      if (!server.mtProxyPort) {
        continue;
      }
      try {
        await this.rotateSecretFor(server);
      } catch (error) {
        this.logger.warn(`Не удалось обновить ключ mtproxy на сервере "${server.name}": ${(error as Error).message}`);
      }
    }
  }

  private async rotateSecretFor(server: Server): Promise<void> {
    const connection = this.vpnProvisioningService.connectionParams(server);
    const secret = randomBytes(16).toString('hex');
    await this.sshService.withConnection(connection, (ssh) =>
      this.sshService.execOrThrow(
        ssh,
        `sed -i 's/"ephemeral": ".*"/"ephemeral": "${secret}"/' /opt/mtproxy-src/config.py && systemctl restart ${UNIT_NAME}`,
      ),
    );
    server.mtProxySecretEnc = encryptSecret(secret);
    server.mtProxyUpdatedAt = new Date();
    await this.serversRepository.save(server);
    this.logger.log(`Ключ mtproxy обновлён на сервере "${server.name}"`);
  }

  private toStatus(server: Server): MtProxyStatus {
    if (!server.mtProxyPort || !server.mtProxySecretEnc) {
      return { installed: false, server: null, port: null, secret: null, deepLink: null, updatedAt: null };
    }
    const clientSecret = this.buildClientSecret(decryptSecret(server.mtProxySecretEnc));
    return {
      installed: true,
      server: server.host,
      port: server.mtProxyPort,
      secret: clientSecret,
      deepLink: `tg://proxy?server=${server.host}&port=${server.mtProxyPort}&secret=${clientSecret}`,
      updatedAt: server.mtProxyUpdatedAt,
    };
  }

  // ee-префикс + hex-encoded TLS_DOMAIN — формат fake-TLS секрета, который сам
  // mtprotoproxy.py печатает как рекомендуемый при MODES.tls=True (проверено вживую при
  // диагностике 2026-08-14: "ephemeral: tg://proxy?...&secret=ee<secret><hex(domain)>").
  // Голый секрет без префикса Telegram-клиенты отклоняют, раз classic-режим выключен —
  // именно это, а не только зависание SSH (см. историю), было второй причиной, почему
  // выданная ссылка не работала.
  private buildClientSecret(secret: string): string {
    const domainHex = Buffer.from(TLS_DOMAIN, 'utf8').toString('hex');
    return `ee${secret}${domainHex}`;
  }

  private async findServerOrFail(serverId: string): Promise<Server> {
    const server = await this.serversRepository.findOne({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }
    return server;
  }
}
