import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NodeSSH } from 'node-ssh';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { BridgeLogService } from '../bridge-log/bridge-log.service';
import { Bridge } from '../bridges/bridge.entity';
import { probeTcpPort } from '../common/tcp-probe.util';
import { decryptSecret } from '../common/encryption.util';
import { LogLevel, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { SshConnectionParams, SshService } from '../ssh/ssh.service';
import { AmneziaWgDriver } from './amnezia-wg.driver';
import { assertSupportedCidr, nextCidr } from './network.util';
import { PeerSpec, PeerTransferStats, ScannedPeer, UpstreamPeerConfig, VpnDriver } from './vpn-driver.interface';
import { WireGuardDriver } from './wireguard.driver';

export interface Fail2banStatus {
  installed: boolean;
  bannedCount: number;
}

// См. VpnProvisioningService.rebootForKernelModule — перезагрузка сервера (после явного
// подтверждения администратором, см. checkKernelModuleReadiness), когда DKMS уже собрал
// модуль протокола под другое ядро, чем сейчас загружено. GRACE — не проверять
// доступность сразу после отправки "reboot" (серверу нужно время просто НАЧАТЬ выключаться,
// иначе первая же проба TCP ещё застаёт живой sshd и ложно решает, что сервер "уже вернулся").
// TIMEOUT — с запасом под proxy_read_timeout 300s на /api/ (см. nginx.conf.template).
const KERNEL_REBOOT_GRACE_MS = 5_000;
const KERNEL_REBOOT_TIMEOUT_MS = 150_000;
const KERNEL_REBOOT_POLL_MS = 4_000;
const KERNEL_REBOOT_SSHD_SETTLE_MS = 3_000;

@Injectable()
export class VpnProvisioningService {
  private readonly logger = new Logger(VpnProvisioningService.name);
  private readonly drivers: Record<VpnProtocol, VpnDriver>;

  constructor(
    private readonly sshService: SshService,
    private readonly wireGuardDriver: WireGuardDriver,
    private readonly amneziaWgDriver: AmneziaWgDriver,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    private readonly bridgeLogService: BridgeLogService,
  ) {
    this.drivers = {
      [VpnProtocol.WIREGUARD]: this.wireGuardDriver,
      [VpnProtocol.AMNEZIAWG]: this.amneziaWgDriver,
    };
  }

  driverFor(protocol: VpnProtocol): VpnDriver {
    return this.drivers[protocol];
  }

  connectionParams(server: Server): SshConnectionParams {
    return {
      host: server.host,
      port: server.sshPort,
      username: server.sshUsername,
      authType: server.sshAuthType,
      secret: decryptSecret(server.sshSecretEnc),
      // TOFU — см. SshService/Server.sshHostKeyFingerprint. Персист нового отпечатка при
      // первом подключении — fire-and-forget (сама SSH-операция, ради которой открывали
      // это соединение, не должна ждать/падать из-за отдельной записи в БД).
      knownHostKeyFingerprint: server.sshHostKeyFingerprint,
      onHostKeyTrustedOnFirstUse: (fingerprint) => {
        this.serversRepository.update(server.id, { sshHostKeyFingerprint: fingerprint }).catch((error) => {
          this.logger.warn(`Не удалось сохранить отпечаток SSH host key сервера "${server.name}": ${(error as Error).message}`);
        });
      },
    };
  }

  // Пойманный вживую реальный сценарий (2026-08-07): DKMS уже собрал и установил модуль
  // протокола (обычно AmneziaWG), но под ДРУГОЕ ядро, чем сейчас реально загружено на
  // сервере — типично после apt upgrade, подтянувшего новее kernel-пакет, без
  // последующей перезагрузки. "<quickBinary> up" в этом случае падает с "Unknown device
  // type" (см. withKernelModuleHint в драйвере) — но раз DKMS уже показывает "installed"
  // для конкретной версии ядра, проблема чинится ровно одной перезагрузкой, без участия
  // человека. Вызывается ДО открытия "основного" соединения для install()/connectAsClient()
  // — та же логика (ensureClientToolsInstalled → сборка DKMS) должна уже отработать один
  // раз к этому моменту, иначе dkms status ещё пуст (см. вызовы ниже: сначала пакеты, потом
  // эта проверка).
  //
  // ВАЖНО: перезагрузка — это перезагрузка ВСЕГО сервера — если на нём уже есть другие
  // активные протоколы/peers, они на время перезагрузки (обычно 30-90с) тоже недоступны.
  // Это неизбежное следствие смены ядра, не обойти без реальной перезагрузки (модуль
  // физически отсутствует в /lib/modules/<текущее ядро>). Раньше эта перезагрузка
  // происходила АВТОМАТИЧЕСКИ и молча — реальный пойманный вживую случай (2026-08-27):
  // рассинхронизация обнаружилась в момент, когда на сервере УЖЕ было больше 20 живых
  // клиентских peers, и все они на минуту отвалились без предупреждения и без единого
  // следа в audit-log/bridge-log (сам вызов install()/connectAsClient() не обязательно
  // приходит из-под аутентифицированного HTTP-запроса, который логируется). Теперь
  // рассинхронизация даёт явную ошибку с просьбой подтвердить перезагрузку (см.
  // KERNEL_REBOOT_REQUIRED ниже и rebootForKernelModule) — админ должен явно решить,
  // прерывать ли живые подключения прямо сейчас или отложить до менее нагруженного момента.
  //
  // Если модуль вообще не собран (rebootKernel: null, см. KernelModuleStatus) —
  // перезагрузка не поможет, ничего не делаем и даём install()/connectAsClient() провалиться
  // как обычно — withKernelModuleHint даст пользователю ручную инструкцию.
  private async checkKernelModuleReadiness(server: Server, connection: SshConnectionParams, driver: VpnDriver): Promise<void> {
    const status = await this.sshService.withConnection(connection, (ssh) => driver.checkKernelModuleStatus(ssh));
    if (status.ready || !status.rebootKernel) {
      return;
    }
    const message =
      `Модуль ${driver.protocol} на сервере "${server.name}" собран для ядра ${status.rebootKernel}, но сервер ` +
      `сейчас работает на другом ядре. Требуется перезагрузка сервера, чтобы применить нужный модуль — она прервёт ` +
      `ВСЕ активные подключения на этом сервере на 30-90с. Подтвердите перезагрузку и повторите действие.`;
    this.bridgeLogService.log(
      LogLevel.WARN,
      `Требуется подтверждение перезагрузки сервера "${server.name}": модуль ${driver.protocol} собран не под текущее ядро`,
    );
    // code — структурированный маркер для фронтенда (см. getErrorMessage/KernelRebootConfirmDialog
    // на фронте), чтобы отличить именно этот случай от обычной ошибки и предложить кнопку
    // "Перезагрузить и повторить" вместо просто текста ошибки.
    throw new BadRequestException({
      code: 'KERNEL_REBOOT_REQUIRED',
      message,
      serverId: server.id,
      serverName: server.name,
      protocol: driver.protocol,
    });
  }

  // Собственно перезагрузка + ожидание готовности модуля — вызывается ТОЛЬКО после явного
  // подтверждения администратором (см. ServersController.rebootForKernelModule), в отличие
  // от checkKernelModuleReadiness выше, которая сама никогда не перезагружает.
  async rebootForKernelModule(serverId: string, protocol: VpnProtocol): Promise<{ message: string }> {
    const server = await this.serversRepository.findOne({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(server);

    this.logger.warn(
      `Подтверждена перезагрузка сервера "${server.name}" для применения модуля ${protocol} (до ${KERNEL_REBOOT_TIMEOUT_MS / 1000}с)…`,
    );
    this.bridgeLogService.log(LogLevel.WARN, `Подтверждена перезагрузка сервера "${server.name}" для модуля ${protocol}`);
    try {
      await this.sshService.withConnection(connection, (ssh) => this.sshService.exec(ssh, 'reboot'));
    } catch {
      // Соединение обрывается вместе с перезагрузкой — ожидаемо, не ошибка (см. ServersService.reboot).
    }
    await new Promise((resolve) => setTimeout(resolve, KERNEL_REBOOT_GRACE_MS));
    const deadline = Date.now() + KERNEL_REBOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await probeTcpPort(server.host, server.sshPort, 3000)) {
        // SSH-порт нередко открывается раньше, чем система (и DKMS-модули) полностью готовы.
        await new Promise((resolve) => setTimeout(resolve, KERNEL_REBOOT_SSHD_SETTLE_MS));
        const recheck = await this.sshService.withConnection(connection, (ssh) => driver.checkKernelModuleStatus(ssh));
        if (!recheck.ready) {
          const message = `Сервер "${server.name}" перезагрузился, но модуль ${protocol} всё ещё недоступен для текущего ` +
            `ядра — возможно, загрузчик выбирает не ту версию ядра по умолчанию. Проверьте по SSH "uname -r" и "dkms status".`;
          this.bridgeLogService.log(LogLevel.ERROR, message);
          throw new BadRequestException(message);
        }
        this.logger.log(`Сервер "${server.name}" вернулся после перезагрузки, модуль ${protocol} готов`);
        this.bridgeLogService.log(LogLevel.INFO, `Сервер "${server.name}" вернулся после перезагрузки, модуль ${protocol} готов`);
        return { message: `Сервер "${server.name}" перезагружен, модуль ${protocol} готов — повторите действие` };
      }
      await new Promise((resolve) => setTimeout(resolve, KERNEL_REBOOT_POLL_MS));
    }
    const timeoutMessage = `Сервер "${server.name}" не вернулся в сеть после перезагрузки в течение ${KERNEL_REBOOT_TIMEOUT_MS / 1000}с`;
    this.bridgeLogService.log(LogLevel.ERROR, timeoutMessage);
    throw new BadRequestException(timeoutMessage);
  }

  async installProtocol(
    serverId: string,
    protocol: VpnProtocol,
    listenPort: number,
    networkCidr: string,
    mtu?: number,
    interfaceName?: string,
  ): Promise<ServerProtocol> {
    assertSupportedCidr(networkCidr);
    const server = await this.serversRepository.findOne({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }

    // Порт, а не только протокол — на одном self-сервере может стоять несколько мостов с
    // одним и тем же протоколом (разные порты/сети): без учёта порта второй мост считался
    // бы "уже установлен" из-за первого.
    const existing = await this.serverProtocolsRepository.findOne({ where: { serverId, protocol, listenPort } });
    if (existing && existing.status === ServerProtocolStatus.ACTIVE) {
      throw new BadRequestException('Этот протокол уже установлен на сервере');
    }

    // Порт/сеть должны быть уникальны в пределах сервера НЕЗАВИСИМО от протокола — иначе
    // второй протокол на том же порту/сети ловит малопонятную ошибку прямо на SSH-уровне
    // ("RTNETLINK answers: Address already in use" от ip/wg-quick). Раньше при конфликте
    // просто отклоняли запрос с просьбой выбрать другие значения вручную — теперь сервер сам
    // подбирает следующую свободную пару (порт +1, третий октет сети +1 — см. nextCidr),
    // пока не найдёт свободную (поймано вживую: форма установки протокола на фронтенде
    // подставляет одинаковые порт/сеть по умолчанию для любого протокола, легко не заметить
    // при добавлении второго протокола/моста на тот же сервер). Смотрим ЛЮБОЙ другой
    // протокол на сервере (не только отличный от устанавливаемого — self-сервер может нести
    // несколько мостов с одним и тем же VPN-протоколом на разных портах/сетях) и только
    // ACTIVE/INSTALLING — ERROR уже откатил себя при неудачной установке (см. driver.install)
    // и ничего реально не занимает на сервере; сам `existing` (переустановка того же
    // протокола на том же порту) исключается — он не "чужой" конфликт.
    const others = await this.serverProtocolsRepository.find({
      where: {
        serverId,
        status: In([ServerProtocolStatus.ACTIVE, ServerProtocolStatus.INSTALLING]),
        ...(existing ? { id: Not(existing.id) } : {}),
      },
    });
    const usedPorts = new Set(others.map((sp) => sp.listenPort));
    const usedCidrs = new Set(others.map((sp) => sp.networkCidr));

    let resolvedPort = listenPort;
    while (usedPorts.has(resolvedPort)) {
      resolvedPort += 1;
      if (resolvedPort > 65535) {
        throw new BadRequestException('Не удалось подобрать свободный порт на этом сервере');
      }
    }
    let resolvedCidr = networkCidr;
    while (usedCidrs.has(resolvedCidr)) {
      resolvedCidr = nextCidr(resolvedCidr);
    }
    if (resolvedPort !== listenPort || resolvedCidr !== networkCidr) {
      this.logger.log(
        `Порт/сеть для ${protocol} на сервере "${server.name}" заняты другим интерфейсом — ` +
          `автоматически выбраны ${resolvedCidr}:${resolvedPort} (запрошено ${networkCidr}:${listenPort})`,
      );
    }

    let serverProtocol =
      existing ||
      this.serverProtocolsRepository.create({
        serverId,
        protocol,
        interfaceName: '',
        nextHostOctet: 2,
      });
    // На переустановке ранее упавшего протокола (existing.status === ERROR) порт/сеть тоже
    // могли с тех пор занять — resolvedPort/resolvedCidr выше уже это учитывают, но их нужно
    // явно применить и к переиспользуемой записи, не только к только что созданной.
    serverProtocol.listenPort = resolvedPort;
    serverProtocol.networkCidr = resolvedCidr;
    serverProtocol.status = ServerProtocolStatus.INSTALLING;
    serverProtocol.lastError = null;
    serverProtocol = await this.serverProtocolsRepository.save(serverProtocol);

    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(server);

    // Установка (особенно AmneziaWG: add-apt-repository + apt-get update + install из PPA)
    // может занимать дольше, чем таймаут HTTP-прокси перед этим эндпоинтом (см.
    // nginx/nginx.conf.template) — если клиент к этому моменту уже отвалился по таймауту,
    // единственный способ узнать реальный исход операции без похода в БД напрямую — вот
    // этот лог (Настройки → «Логи» → backend).
    this.logger.log(`Установка ${protocol} на сервере "${server.name}" (${server.host}:${resolvedPort})…`);
    try {
      await this.checkKernelModuleReadiness(server, connection, driver);
      // Версию забираем в ТОЙ ЖЕ SSH-сессии, что и саму установку — не открываем отдельное
      // подключение только ради неё.
      const result = await this.sshService.withConnection(connection, async (ssh) => {
        const installResult = await driver.install(
          { ssh, server, serverProtocol },
          { listenPort: resolvedPort, networkCidr: resolvedCidr, mtu, interfaceName },
        );
        const packageVersion = await driver.getInstalledVersion({ ssh, server, serverProtocol });
        return { ...installResult, packageVersion };
      });
      serverProtocol.interfaceName = result.interfaceName;
      serverProtocol.serverPublicKey = result.serverPublicKey;
      serverProtocol.obfuscationParams = result.obfuscationParams || null;
      serverProtocol.mtu = result.mtu || null;
      serverProtocol.packageVersion = result.packageVersion;
      serverProtocol.status = ServerProtocolStatus.ACTIVE;
      this.logger.log(`${protocol} успешно установлен на сервере "${server.name}" (интерфейс ${result.interfaceName})`);
    } catch (error) {
      serverProtocol.status = ServerProtocolStatus.ERROR;
      serverProtocol.lastError = this.extractErrorMessage(error);
      this.logger.error(`Установка ${protocol} на сервере "${server.name}" не удалась: ${serverProtocol.lastError}`);
      // KERNEL_REBOOT_REQUIRED — не обычная неудача установки, а запрос подтверждения у
      // пользователя (см. checkKernelModuleReadiness/rebootForKernelModule ниже): состояние
      // сохраняем как обычно (чтобы lastError был виден при перезагрузке страницы), но саму
      // ошибку пробрасываем дальше — иначе она бы осела 200-м ответом с status=error, и
      // фронтенд не смог бы отличить её от произвольного сбоя SSH, чтобы показать диалог
      // подтверждения перезагрузки вместо обычного текста ошибки.
      await this.serverProtocolsRepository.save(serverProtocol);
      if (this.isKernelRebootRequiredError(error)) {
        throw error;
      }
      return serverProtocol;
    }

    return this.serverProtocolsRepository.save(serverProtocol);
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'object' && response && 'message' in response) {
        return String((response as { message: unknown }).message);
      }
    }
    return error instanceof Error ? error.message : String(error);
  }

  private isKernelRebootRequiredError(error: unknown): boolean {
    if (!(error instanceof BadRequestException)) {
      return false;
    }
    const response = error.getResponse();
    return typeof response === 'object' && response !== null && (response as { code?: string }).code === 'KERNEL_REBOOT_REQUIRED';
  }

  async getInstalledVersion(serverProtocol: ServerProtocol, server: Server): Promise<string | null> {
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(server);
    return this.sshService.withConnection(connection, (ssh) => driver.getInstalledVersion({ ssh, server, serverProtocol }));
  }

  async updateProtocolPackage(serverProtocol: ServerProtocol, server: Server): Promise<string | null> {
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(server);
    return this.sshService.withConnection(connection, (ssh) => driver.updatePackage({ ssh, server, serverProtocol }));
  }

  // Реально снимает протокол с сервера (down, автозапуск, конфиг/ключи) — используется при
  // удалении протокола из панели (см. ServersService.removeProtocol), в отличие от
  // удаления самого СЕРВЕРА (ServersService.remove), которое SSH намеренно не трогает
  // (сервер обычно удаляют именно потому, что он недоступен).
  async uninstallProtocol(serverProtocol: ServerProtocol, server: Server): Promise<void> {
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(server);
    await this.sshService.withConnection(connection, (ssh) => driver.uninstall({ ssh, server, serverProtocol }));
  }

  async scanExistingPeers(serverProtocolId: string): Promise<ScannedPeer[]> {
    const serverProtocol = await this.serverProtocolsRepository.findOne({
      where: { id: serverProtocolId },
      relations: ['server'],
    });
    if (!serverProtocol) {
      throw new NotFoundException('Протокол сервера не найден');
    }
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(serverProtocol.server);
    return this.sshService.withConnection(connection, (ssh) =>
      driver.scanExistingPeers({ ssh, server: serverProtocol.server, serverProtocol }),
    );
  }

  async applyPeers(serverProtocol: ServerProtocol, server: Server, peers: PeerSpec[]): Promise<void> {
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(server);
    await this.sshService.withConnection(connection, (ssh) =>
      driver.applyPeers({ ssh, server, serverProtocol }, peers),
    );
  }

  // Для дашборда (см. dashboard/) — общая нагрузка хоста (1-минутный loadavg, число ядер
  // для перевода loadavg в примерный % CPU, память, диск корневого раздела) И живая
  // статистика трафика по peer'ам КАЖДОГО активного протокола сервера — всё за ОДНО SSH-
  // подключение. Раньше это были отдельные getServerLoad()/getTransferStats() с отдельным
  // withConnection() на каждый вызов: 1 (loadavg) + N (по числу активных протоколов)
  // независимых SSH-хендшейков на сервер каждые 7с опроса дашборда навсегда — Diffie-
  // Hellman + подпись при каждом коннекте не бесплатны что для backend, что для самого VPS.
  // Если подключиться не удалось вообще — бросаем (как раньше бросал getTransferStats),
  // buildSnapshot() в dashboard.service.ts уже ловит это через Promise.allSettled и рисует
  // сервер офлайн.
  async getServerSnapshot(
    server: Server,
    activeProtocols: ServerProtocol[],
  ): Promise<{
    load: {
      loadAvg1: number | null;
      cpuCores: number | null;
      memTotalMb: number | null;
      memUsedMb: number | null;
      diskTotalMb: number | null;
      diskUsedMb: number | null;
    };
    transferStatsByProtocolId: Map<string, Map<string, PeerTransferStats>>;
  }> {
    const connection = this.connectionParams(server);
    const transferStatsByProtocolId = new Map<string, Map<string, PeerTransferStats>>();

    const load = await this.sshService.withConnection(connection, async (ssh) => {
      const loadResult = await this.sshService.exec(ssh, `cat /proc/loadavg`);
      const cpuResult = await this.sshService.exec(ssh, `nproc`);
      const memResult = await this.sshService.exec(ssh, `free -m | awk '/Mem:/ {print $2, $3}'`);
      const diskResult = await this.sshService.exec(ssh, `df -k / | tail -1 | awk '{print $2, $3}'`);

      const loadAvg1 = loadResult.code === 0 ? parseFloat(loadResult.stdout.trim().split(/\s+/)[0]) : null;
      const cpuCores = cpuResult.code === 0 ? parseInt(cpuResult.stdout.trim(), 10) : null;
      const [memTotal, memUsed] = memResult.code === 0 ? memResult.stdout.trim().split(/\s+/) : [];
      // df -k выводит в 1024-байтных блоках — переводим в МБ тем же способом, что и free -m.
      const [diskTotalKb, diskUsedKb] = diskResult.code === 0 ? diskResult.stdout.trim().split(/\s+/) : [];

      for (const serverProtocol of activeProtocols) {
        const driver = this.driverFor(serverProtocol.protocol);
        transferStatsByProtocolId.set(serverProtocol.id, await driver.getTransferStats({ ssh, server, serverProtocol }));
      }

      return {
        loadAvg1: Number.isFinite(loadAvg1) ? loadAvg1 : null,
        cpuCores: cpuCores !== null && Number.isFinite(cpuCores) && cpuCores > 0 ? cpuCores : null,
        memTotalMb: memTotal !== undefined ? Number(memTotal) : null,
        memUsedMb: memUsed !== undefined ? Number(memUsed) : null,
        diskTotalMb: diskTotalKb !== undefined ? Math.round(Number(diskTotalKb) / 1024) : null,
        diskUsedMb: diskUsedKb !== undefined ? Math.round(Number(diskUsedKb) / 1024) : null,
      };
    });

    return { load, transferStatsByProtocolId };
  }

  // Ищет на сервере уже настроенный (не через наш сервис) VPN по стандартным путям
  // установки протокола и, если находит, заводит/обновляет запись ServerProtocol на
  // основе найденной конфигурации (не переустанавливая и не трогая сам VPN-интерфейс).
  // Возвращает null, если для этого протокола на сервере ничего не найдено.
  async detectExisting(serverId: string, protocol: VpnProtocol): Promise<ServerProtocol | null> {
    const server = await this.serversRepository.findOne({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }

    const existing = await this.serverProtocolsRepository.findOne({ where: { serverId, protocol } });
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(server);

    const detection = await this.sshService.withConnection(connection, (ssh) => driver.detectExisting(ssh));
    if (!detection) {
      return null;
    }

    const serverProtocol =
      existing ||
      this.serverProtocolsRepository.create({
        serverId,
        protocol,
        nextHostOctet: 2,
      });
    serverProtocol.interfaceName = detection.interfaceName;
    serverProtocol.listenPort = detection.listenPort;
    serverProtocol.networkCidr = detection.networkCidr;
    serverProtocol.serverPublicKey = detection.serverPublicKey;
    serverProtocol.obfuscationParams = detection.obfuscationParams || null;
    serverProtocol.execContainer = detection.execContainer ?? null;
    serverProtocol.remoteConfDir = detection.remoteConfDir ?? null;
    serverProtocol.remoteInterfaceAddress = detection.remoteInterfaceAddress ?? null;
    serverProtocol.status = ServerProtocolStatus.ACTIVE;
    serverProtocol.lastError = null;

    return this.serverProtocolsRepository.save(serverProtocol);
  }

  // Ставит CLI-инструменты протокола на selfServer (не трогая конфиг/интерфейсы) — нужно
  // перед connectBridgeUpstream, если self-сервер ещё не имел дела с этим протоколом.
  async ensureClientToolsInstalled(selfServer: Server, protocol: VpnProtocol): Promise<void> {
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, (ssh) => driver.ensureClientToolsInstalled(ssh));
  }

  // Режим моста: поднимает на selfServer интерфейс в роли клиента к upstream-серверу.
  async connectBridgeUpstream(
    selfServer: Server,
    protocol: VpnProtocol,
    interfaceName: string,
    config: UpstreamPeerConfig,
    routeTable: number,
  ): Promise<void> {
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(selfServer);
    await this.checkKernelModuleReadiness(selfServer, connection, driver);
    await this.sshService.withConnection(connection, (ssh) => driver.connectAsClient(ssh, interfaceName, config, routeTable));
  }

  async disconnectBridgeUpstream(selfServer: Server, protocol: VpnProtocol, interfaceName: string): Promise<void> {
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, (ssh) => driver.disconnectAsClient(ssh, interfaceName));
  }

  // Режим моста: NAT+forwarding+policy routing на self-сервере — трафик ИЗ СЕТЕЙ
  // КЛИЕНТОВ МОСТА (и только их — один или два клиентских интерфейса, если у моста
  // включены и WireGuard, и AmneziaWG одновременно) уходит через upstream-интерфейс
  // вместо обычного egress хоста; остальной трафик self-сервера (включая его
  // собственную связность — SSH и т.п., и трафик ДРУГИХ мостов на том же хосте, у
  // каждого своя routeTable) продолжает идти через основной маршрут без изменений.
  // Настраивается один раз при первом подключении upstream (правила ссылаются только
  // на имена интерфейсов, которые не меняются при последующих переключениях upstream).
  // ИДЕМПОТЕНТНО: каждая команда сначала проверяет (-C для iptables, grep по `ip rule
  // show` для policy routing), существует ли правило, и добавляет только если его нет.
  // Раньше вызывалось только ОДИН раз — при первом назначении upstream моста (расчёт был
  // на то, что правила ссылаются на постоянные имена интерфейсов и не требуют
  // пересоздания при последующих переключениях) — но `ip rule`/iptables это состояние
  // ядра, не переживающее перезагрузку self-сервера, и ничего не пересоздавало их
  // само собой. Поймано вживую: правило исчезло (сервер перезагружали/что-то его
  // сбросило), трафик клиентов моста стал молча уходить через обычный интернет
  // self-сервера вместо upstream-туннеля — работоспособность моста никак не
  // сигнализировала об этой поломке. Теперь setupBridgeNat вызывается при КАЖДОМ
  // setUpstream (см. bridges.service.ts) — самовосстанавливается при следующем же
  // переключении, а не только при самом первом назначении.
  async setupBridgeNat(
    selfServer: Server,
    clientInterfaces: Array<{ networkCidr: string; interfaceName: string }>,
    upstreamInterfaceName: string,
    routeTable: number,
  ): Promise<void> {
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, async (ssh) => {
      await this.sshService.execOrThrow(
        ssh,
        `sysctl -w net.ipv4.ip_forward=1 && (grep -q net.ipv4.ip_forward /etc/sysctl.d/99-vpnmanager.conf 2>/dev/null || echo net.ipv4.ip_forward=1 >> /etc/sysctl.d/99-vpnmanager.conf)`,
      );
      for (const { networkCidr, interfaceName } of clientInterfaces) {
        await this.sshService.execOrThrow(
          ssh,
          `iptables -t nat -C POSTROUTING -s ${networkCidr} -o ${upstreamInterfaceName} -j MASQUERADE 2>/dev/null || ` +
            `iptables -t nat -A POSTROUTING -s ${networkCidr} -o ${upstreamInterfaceName} -j MASQUERADE`,
        );
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -i ${interfaceName} -o ${upstreamInterfaceName} -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -i ${interfaceName} -o ${upstreamInterfaceName} -j ACCEPT`,
        );
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -i ${upstreamInterfaceName} -o ${interfaceName} -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -i ${upstreamInterfaceName} -o ${interfaceName} -j ACCEPT`,
        );
        // Только пакеты с источником из сети ЭТОГО клиентского интерфейса ищут маршрут
        // в отдельной таблице ЭТОГО моста (routeTable — там upstream — шлюз по
        // умолчанию, см. connectAsClient); всё остальное на хосте по-прежнему
        // резолвится через main. Приоритет 100 — заведомо раньше правила main (32766).
        await this.sshService.execOrThrow(
          ssh,
          `ip rule show | grep -q "from ${networkCidr} lookup ${routeTable}" || ` +
            `ip rule add from ${networkCidr} table ${routeTable} priority 100`,
        );
      }
    });
  }

  // Общая для ВСЕХ мостов на self-сервере метка и правило маршрутизации — работает сразу
  // для любого числа мостов: КАКОЙ трафик получает метку решает ipset+mangle-правило
  // каждого конкретного моста (см. ниже), а куда её направить — одно общее правило.
  private static readonly BYPASS_FWMARK = '0x2a';
  private static readonly BYPASS_RULE_PRIORITY = 90;

  // Список обхода upstream моста (Bridge.bypassDestinations, задаётся в настройках моста) —
  // трафик клиентов моста к этим доменам/IP должен идти НАПРЯМУЮ с self-сервера, минуя
  // upstream ("зарубежный" сервер). Приоритет 100 у "весь трафик клиента -> routeTable"
  // (см. setupBridgeNat выше) — здесь используется МЕНЬШИЙ priority (90, выше по
  // приоритету для `ip rule`), поэтому совпавшие с ipset пакеты уходят через main ДО того,
  // как дошли бы до правила на routeTable.
  //
  // Механизм: iptables mangle помечает пакет (MARK) при совпадении dst с ipset моста ->
  // `ip rule fwmark ... lookup main` направляет помеченные пакеты в main вместо routeTable
  // -> отдельный MASQUERADE и FORWARD ACCEPT для этого пути (приватный IP клиента иначе не
  // смог бы выйти в интернет напрямую и/или был бы отброшен в FORWARD). Обратное
  // направление (ответы) не помечено (mark не переживает новый проход через PREROUTING у
  // ответных пакетов) — пропускается по ESTABLISHED,RELATED, а не по метке.
  //
  // destinations — уже финальный плоский список (IP/CIDR как есть + ещё НЕ резолвленные
  // домены, см. BridgesService.syncBypassRules/refreshBypassRules) — резолвинг доменов
  // делает сама эта функция, одним SSH-сеансом вместе с остальной настройкой.
  async setupBridgeBypass(
    selfServer: Server,
    bridgeId: string,
    clientInterfaces: Array<{ networkCidr: string; interfaceName: string }>,
    destinations: string[],
  ): Promise<void> {
    const connection = this.connectionParams(selfServer);
    // ipset ограничивает длину имени (IPSET_MAXLEN=32) — префикс + 16 hex-символов id с
    // запасом укладывается.
    const ipsetName = `vpnmgr-byp-${bridgeId.replace(/-/g, '').slice(0, 16)}`;
    const tmpSetName = `${ipsetName}-tmp`;
    const fwmark = VpnProvisioningService.BYPASS_FWMARK;

    await this.sshService.withConnection(connection, async (ssh) => {
      // ipset не всегда стоит из коробки (в отличие от iptables/ip) — доустанавливаем при
      // необходимости, идемпотентно.
      await this.sshService.execOrThrow(ssh, `which ipset >/dev/null 2>&1 || (apt-get update -y && apt-get install -y ipset)`);

      const ips: string[] = [];
      const domains: string[] = [];
      for (const destination of destinations) {
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(destination)) {
          ips.push(destination);
        } else {
          domains.push(destination);
        }
      }
      if (domains.length > 0) {
        // Один SSH-запрос на все домены сразу — резолвим тем же резолвером, что видит и
        // сам self-сервер (getent ahostsv4 отдаёт ВСЕ A-записи, не только первую — важно
        // для доменов за CDN с несколькими IP).
        const script = domains.map((domain) => `getent ahostsv4 ${domain} 2>/dev/null | awk '{print $1}'`).join('; ');
        const result = await this.sshService.exec(ssh, script);
        const resolved = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(line));
        ips.push(...new Set(resolved.map((ip) => `${ip}/32`)));
      }

      // create -exist — идемпотентно (не падает, если ipset уже существует). swap вместо
      // flush+add — атомарная замена содержимого, без "окна", когда набор пуст между
      // пересчётами (домен временно не резолвится и т.п.).
      await this.sshService.execOrThrow(ssh, `ipset create ${ipsetName} hash:net -exist`);
      await this.sshService.execOrThrow(ssh, `ipset create ${tmpSetName} hash:net -exist`);
      await this.sshService.execOrThrow(ssh, `ipset flush ${tmpSetName}`);
      for (const ip of ips) {
        await this.sshService.execOrThrow(ssh, `ipset add ${tmpSetName} ${ip} -exist`);
      }
      await this.sshService.execOrThrow(ssh, `ipset swap ${tmpSetName} ${ipsetName}`);
      await this.sshService.execOrThrow(ssh, `ipset destroy ${tmpSetName}`);

      // Общее для ВСЕХ мостов на этом self-сервере правило — идемпотентно, безопасно
      // вызывать из каждого моста по отдельности.
      await this.sshService.execOrThrow(
        ssh,
        `ip rule show | grep -q "fwmark ${fwmark} lookup main" || ` +
          `ip rule add fwmark ${fwmark} lookup main priority ${VpnProvisioningService.BYPASS_RULE_PRIORITY}`,
      );

      for (const { networkCidr, interfaceName } of clientInterfaces) {
        await this.sshService.execOrThrow(
          ssh,
          `iptables -t mangle -C PREROUTING -s ${networkCidr} -m set --match-set ${ipsetName} dst -j MARK --set-mark ${fwmark} 2>/dev/null || ` +
            `iptables -t mangle -A PREROUTING -s ${networkCidr} -m set --match-set ${ipsetName} dst -j MARK --set-mark ${fwmark}`,
        );
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -i ${interfaceName} -m mark --mark ${fwmark} -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -i ${interfaceName} -m mark --mark ${fwmark} -j ACCEPT`,
        );
        // Ответные пакеты приходят новым проходом через PREROUTING без метки (mark не
        // переживает границу соединения) — пропускаем их по ESTABLISHED,RELATED, а не по
        // fwmark, иначе исходящая часть работала бы, а ответы обрубались бы в FORWARD.
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -o ${interfaceName} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -o ${interfaceName} -m state --state ESTABLISHED,RELATED -j ACCEPT`,
        );
        // Трафик в обход upstream всё равно исходит из приватной подсети клиентов моста —
        // без MASQUERADE именно для этого пути (в дополнение к upstream-специфичному из
        // setupBridgeNat) пакеты уходили бы с нероутящимся приватным source.
        await this.sshService.execOrThrow(
          ssh,
          `iptables -t nat -C POSTROUTING -s ${networkCidr} -m mark --mark ${fwmark} -j MASQUERADE 2>/dev/null || ` +
            `iptables -t nat -A POSTROUTING -s ${networkCidr} -m mark --mark ${fwmark} -j MASQUERADE`,
        );
      }
    });
  }

  // Устанавливает и настраивает fail2ban на клиентском VPS — вызывается при добавлении
  // сервера (ServersService.create) и при бутстрапе self-сервера (BridgesService.create).
  // whitelistIps — IP, которые НЕЛЬЗЯ банить на этом сервере (обычно — публичный IP
  // self-сервера панели): без этого сама панель рано или поздно забанила бы себя на
  // управляемом сервере (например, из-за временного сетевого сбоя при SSH-подключении) и
  // потеряла бы возможность им управлять — цена восстановления намного выше, чем просто
  // не банить заведомо доверенный IP. jail.local переписывается целиком (не мержится) —
  // это НАШ файл, конфиг пакета (jail.conf) не трогаем; сервер уже дедикейтед под VPN, а
  // не общего назначения хост с чужими fail2ban-настройками поверх.
  async ensureFail2ban(server: Server, whitelistIps: string[]): Promise<Fail2banStatus> {
    const connection = this.connectionParams(server);
    return this.sshService.withConnection(connection, async (ssh) => {
      const check = await this.sshService.exec(ssh, 'command -v fail2ban-client');
      if (check.code !== 0) {
        await this.sshService.execOrThrow(
          ssh,
          'export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y fail2ban',
        );
      }

      const uniqueIps = Array.from(new Set(whitelistIps.filter(Boolean)));
      const jailLocal = [
        '[DEFAULT]',
        `ignoreip = 127.0.0.1/8 ::1${uniqueIps.length > 0 ? ' ' + uniqueIps.join(' ') : ''}`,
        '',
        '[sshd]',
        'enabled = true',
        '',
      ].join('\n');
      const encoded = Buffer.from(jailLocal, 'utf8').toString('base64');
      await this.sshService.execOrThrow(
        ssh,
        `mkdir -p /etc/fail2ban && echo ${encoded} | base64 -d > /etc/fail2ban/jail.local && ` +
          `systemctl enable --now fail2ban && systemctl restart fail2ban && sleep 1`,
      );
      return this.readFail2banStatus(ssh);
    });
  }

  // Только чтение состояния, без установки/изменения конфига — для кнопки "обновить" на
  // карточке сервера, когда fail2ban уже настроен и нужно просто освежить счётчик банов.
  async getFail2banStatus(server: Server): Promise<Fail2banStatus> {
    const connection = this.connectionParams(server);
    return this.sshService.withConnection(connection, (ssh) => this.readFail2banStatus(ssh));
  }

  private async readFail2banStatus(ssh: NodeSSH): Promise<Fail2banStatus> {
    const check = await this.sshService.exec(ssh, 'command -v fail2ban-client');
    if (check.code !== 0) {
      return { installed: false, bannedCount: 0 };
    }
    const result = await this.sshService.exec(
      ssh,
      `fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ {gsub(/[ \\t]/,"",$2); print $2}'`,
    );
    const bannedCount = Number(result.stdout.trim());
    return { installed: true, bannedCount: Number.isFinite(bannedCount) ? bannedCount : 0 };
  }

  // Общая для ВСЕХ мостов на self-сервере метка/правило маршрутизации исходящих запросов
  // backend'а к Telegram Bot API через конкретный мост — на случай, если Telegram
  // заблокирован в стране, где расположен сам self-сервер панели (см.
  // SystemSettings.telegramBridgeId). Технически — та же схема, что setupBridgeBypass
  // (ipset+mangle mark+ip rule+NAT), но НАОБОРОТ по смыслу: там исключаем трафик клиентов
  // ИЗ upstream-туннеля, здесь наоборот — принудительно заворачиваем трафик backend'а (не
  // трафик клиентов моста!) В upstream-туннель конкретного моста. Метка отдельная
  // (TELEGRAM_FWMARK ≠ BYPASS_FWMARK), чтобы не пересекаться с обходом.
  private static readonly TELEGRAM_FWMARK = '0x2b';
  private static readonly TELEGRAM_RULE_PRIORITY = 85;

  async setupTelegramRouting(selfServer: Server, bridge: Bridge, telegramDomain = 'api.telegram.org'): Promise<void> {
    const connection = this.connectionParams(selfServer);
    const ipsetName = `vpnmgr-tg-${bridge.id.replace(/-/g, '').slice(0, 16)}`;
    const tmpSetName = `${ipsetName}-tmp`;
    const fwmark = VpnProvisioningService.TELEGRAM_FWMARK;

    await this.sshService.withConnection(connection, async (ssh) => {
      await this.sshService.execOrThrow(ssh, `which ipset >/dev/null 2>&1 || (apt-get update -y && apt-get install -y ipset)`);

      const result = await this.sshService.exec(ssh, `getent ahostsv4 ${telegramDomain} 2>/dev/null | awk '{print $1}'`);
      const ips = Array.from(
        new Set(
          result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(line))
            .map((ip) => `${ip}/32`),
        ),
      );

      await this.sshService.execOrThrow(ssh, `ipset create ${ipsetName} hash:net -exist`);
      await this.sshService.execOrThrow(ssh, `ipset create ${tmpSetName} hash:net -exist`);
      await this.sshService.execOrThrow(ssh, `ipset flush ${tmpSetName}`);
      for (const ip of ips) {
        await this.sshService.execOrThrow(ssh, `ipset add ${tmpSetName} ${ip} -exist`);
      }
      await this.sshService.execOrThrow(ssh, `ipset swap ${tmpSetName} ${ipsetName}`);
      await this.sshService.execOrThrow(ssh, `ipset destroy ${tmpSetName}`);

      // Общее для всех мостов на self-сервере правило — но у КАЖДОГО моста своя routeTable
      // в качестве цели, поэтому идемпотентный чек — по конкретной table, а не только по
      // fwmark (иначе второй мост с телеграм-маршрутизацией не смог бы добавить своё
      // правило после первого).
      await this.sshService.execOrThrow(
        ssh,
        `ip rule show | grep -q "fwmark ${fwmark} lookup ${bridge.routeTable}" || ` +
          `ip rule add fwmark ${fwmark} lookup ${bridge.routeTable} priority ${VpnProvisioningService.TELEGRAM_RULE_PRIORITY}`,
      );
      await this.sshService.execOrThrow(
        ssh,
        `iptables -t mangle -C PREROUTING -m set --match-set ${ipsetName} dst -j MARK --set-mark ${fwmark} 2>/dev/null || ` +
          `iptables -t mangle -A PREROUTING -m set --match-set ${ipsetName} dst -j MARK --set-mark ${fwmark}`,
      );
      await this.sshService.execOrThrow(
        ssh,
        `iptables -t nat -C POSTROUTING -o ${bridge.upstreamInterfaceName} -m mark --mark ${fwmark} -j MASQUERADE 2>/dev/null || ` +
          `iptables -t nat -A POSTROUTING -o ${bridge.upstreamInterfaceName} -m mark --mark ${fwmark} -j MASQUERADE`,
      );
      await this.sshService.execOrThrow(
        ssh,
        `iptables -C FORWARD -o ${bridge.upstreamInterfaceName} -m mark --mark ${fwmark} -j ACCEPT 2>/dev/null || ` +
          `iptables -A FORWARD -o ${bridge.upstreamInterfaceName} -m mark --mark ${fwmark} -j ACCEPT`,
      );
      // Обратное направление (ответы Telegram) — по ESTABLISHED,RELATED, не по метке (mark
      // не переживает новый проход ответных пакетов через PREROUTING), тем же способом,
      // что и setupBridgeBypass.
      await this.sshService.execOrThrow(
        ssh,
        `iptables -C FORWARD -i ${bridge.upstreamInterfaceName} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || ` +
          `iptables -A FORWARD -i ${bridge.upstreamInterfaceName} -m state --state ESTABLISHED,RELATED -j ACCEPT`,
      );
    });
  }
}
