import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'crypto';
import { NodeSSH } from 'node-ssh';
import { Repository } from 'typeorm';
import { Server } from '../servers/server.entity';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';

const MTPROXY_TTL_SECONDS = 600; // 10 минут — ровно то, что попросил пользователь
const MTPROXY_TTL_MS = MTPROXY_TTL_SECONDS * 1000;
// Диапазон заведомо не пересекается с типичными портами уже занятых сервисов на
// self-сервере (SSH, 80/443, backend/postgres в docker-сети, UDP-порты WG/AWG) — ss -ltn
// всё равно перепроверяет перед запуском, диапазон только сужает пространство перебора.
const PORT_RANGE_START = 20000;
const PORT_RANGE_SIZE = 10000;

export interface MtProxySession {
  server: string;
  port: number;
  secret: string;
  expiresAt: Date;
}

// Временный MTProto-proxy на self-сервере моста — единственный способ помочь клиенту
// привязать Telegram (обязательное условие для выдачи конфигов через веб-портал, см.
// TelegramPortalService), если в его стране заблокирован сам Telegram: MTProto-proxy
// проксирует ИМЕННО трафик Telegram-клиента (не общий VPN), поэтому после его настройки
// клиент может открыть бота и пройти /start <token> как обычно.
//
// Использует стороннюю реализацию https://github.com/alexbers/mtprotoproxy (Python,
// без компиляции — официальный C-клиент Telegram (MTProxy) не собирается "из коробки"
// на современных дистрибутивах из-за несовместимости с OpenSSL 3.0, тот же класс проблемы,
// что и известное ограничение установки AmneziaWG из внешнего PPA, см. README). Исходники
// клонируются с GitHub при первой необходимости на self-сервере (не вендорятся в этот
// репозиторий) — если репозиторий недоступен или сменит формат config.py, выдача временного
// прокси упадёт с понятной ошибкой, остальной портал продолжит работать как раньше.
//
// Состояние — только в памяти процесса (тот же trade-off, что у TelegramBotService.drafts/
// peerRequests): рестарт backend теряет запись об активной сессии ДО панели, но НЕ мешает
// самому прокси доработать до конца — его снятие через 10 минут делает независимый скрипт
// на самом self-сервере (nohup+timeout+sleep, отвязанный от SSH-сессии и от backend).
@Injectable()
export class TelegramMtProxyService {
  private readonly logger = new Logger(TelegramMtProxyService.name);
  private readonly sessions = new Map<string, MtProxySession>();

  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    private readonly sshService: SshService,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

  getActiveSession(registrationId: string): MtProxySession | null {
    const session = this.sessions.get(registrationId);
    if (!session) {
      return null;
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(registrationId);
      return null;
    }
    return session;
  }

  buildDeepLink(session: MtProxySession): string {
    return `tg://proxy?server=${session.server}&port=${session.port}&secret=${session.secret}`;
  }

  async issueSession(registrationId: string): Promise<MtProxySession> {
    const existing = this.getActiveSession(registrationId);
    if (existing) {
      return existing;
    }
    const selfServer = await this.serversRepository.findOne({ where: { isSelf: true } });
    if (!selfServer) {
      throw new BadRequestException(
        'Self-сервер ещё не настроен администратором панели — временный доступ к Telegram пока недоступен.',
      );
    }
    const connection = this.vpnProvisioningService.connectionParams(selfServer);
    const sessionId = randomUUID().replace(/-/g, '').slice(0, 12);
    const secret = randomBytes(16).toString('hex');

    const port = await this.sshService.withConnection(connection, async (ssh) => {
      await this.ensureProxySourceInstalled(ssh);
      const freePort = await this.findFreePort(ssh);
      await this.launchProxy(ssh, sessionId, freePort, secret);
      return freePort;
    });

    const session: MtProxySession = { server: selfServer.host, port, secret, expiresAt: new Date(Date.now() + MTPROXY_TTL_MS) };
    this.sessions.set(registrationId, session);
    return session;
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
    throw new Error('Не удалось найти свободный порт на self-сервере для временного прокси');
  }

  // secure+tls-режим (TLS_DOMAIN) — обфусцирует трафик под обычный HTTPS к произвольному
  // домену (fake-TLS), это и есть основная причина использовать именно MTProto-proxy для
  // обхода блокировки, а не просто голый TCP-проброс. cd в каталог сессии, а не абсолютные
  // пути в команде python — mtprotoproxy.py ищет config.py рядом с собой (в каталоге
  // запущенного скрипта), поэтому у каждой сессии своя копия скрипта + свой config.py.
  //
  // setsid (не просто `nohup ... &`) — живьём пойманный на проде инцидент 2026-08-14:
  // `nohup timeout ... python3 mtprotoproxy.py > log 2>&1 < /dev/null &` НЕ отвязывает
  // процесс от SSH-канала, несмотря на полное перенаправление всех трёх потоков — sshd
  // (у non-pty exec-канала) не шлёт EOF, пока жив хотя бы один процесс, унаследовавший
  // сессию исходной команды, а именно так ведёт себя python3 mtprotoproxy.py (в отличие от
  // проверенных вручную `sleep`/голого asyncio/сокета — не воспроизводится). Итог:
  // `ssh.execCommand` в SshService зависал на все MTPROXY_TTL_SECONDS (600с), backend
  // всё ещё ждал ответа, а nginx уже обрывал HTTP-запрос по `proxy_read_timeout 300s` —
  // пользователь получал 504 (HTML, не JSON) и видел общий fallback-текст ошибки на
  // портале, хотя прокси на self-сервере реально поднимался и работал. `setsid` заводит
  // процессу отдельную сессию — SSH-канал закрывается сразу же, без ожидания.
  private async launchProxy(ssh: NodeSSH, sessionId: string, port: number, secret: string): Promise<void> {
    const dir = `/opt/mtproxy-sessions/${sessionId}`;
    const script = `mkdir -p ${dir} && cp /opt/mtproxy-src/mtprotoproxy.py ${dir}/ && cat > ${dir}/config.py <<'PYEOF'
PORT = ${port}
USERS = {
    "ephemeral": "${secret}",
}
MODES = {
    "classic": False,
    "secure": True,
    "tls": True,
}
TLS_DOMAIN = "www.google.com"
PYEOF
command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active" && ufw allow ${port}/tcp || true
setsid sh -c "cd ${dir} && exec timeout ${MTPROXY_TTL_SECONDS} python3 mtprotoproxy.py" < /dev/null > ${dir}/mtproxy.log 2>&1 &
setsid sh -c "sleep $((MTPROXY_TTL_SECONDS + 30)) && rm -rf ${dir}" < /dev/null > /dev/null 2>&1 &`;
    await this.sshService.execOrThrow(ssh, script);
    this.logger.log(`Временный MTProto-proxy запущен на порту ${port} (сессия ${sessionId}, ${MTPROXY_TTL_SECONDS}с)`);
  }
}
