import { execFile, exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemGateway } from './system.gateway';

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

  constructor(
    private readonly configService: ConfigService,
    private readonly systemGateway: SystemGateway,
  ) {}

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

  // Запускает обновление и сразу возвращает управление HTTP-ручке — собственный контейнер
  // backend будет пересоздан последним шагом, поэтому ждать завершения тем же запросом
  // бессмысленно (соединение оборвётся вместе с контейнером). Реальный прогресс шагов
  // транслируется через SystemGateway (WebSocket) — фронтенд подписан на него отдельно.
  // Вывод команд пишется в REPO_PATH/update.log на хосте — переживает пересоздание
  // контейнера, можно посмотреть по SSH.
  triggerUpdate(): { logFile: string } {
    const repoPath = this.getRepoPath();
    const logPath = path.join(repoPath, 'update.log');
    fs.appendFileSync(logPath, `\n--- Обновление запущено ${new Date().toISOString()} ---\n`);

    // Не await — это фактически fire-and-forget с точки зрения HTTP-ручки (см. выше),
    // ошибка внутри уже обрабатывается и транслируется через broadcastUpdateProgress.
    this.runUpdateSequence(repoPath, logPath).catch((error) => {
      this.logger.error(`Обновление завершилось с ошибкой: ${(error as Error).message}`);
    });

    return { logFile: logPath };
  }

  // Пойманный вживую реальный инцидент (2026-08-03) научил разбивать это на отдельные,
  // явно упорядоченные шаги, а не одну команду "up -d --build --force-recreate" на все
  // сервисы разом:
  //
  // 1. postgres никогда не трогаем — его образ/конфиг никогда не меняется этим
  //    обновлением, а force-recreate на нём — чистый лишний риск (реально пересоздавали
  //    и роняли рабочую БД без всякой пользы).
  // 2. nginx/frontend пересоздаём (--force-recreate — иначе бинд-маунт nginx.conf не
  //    подхватит новый файл, git pull заменяет его новым inode) ДО backend, а не после.
  // 3. backend — САМЫЙ ПОСЛЕДНИЙ шаг, и пересоздаётся НЕ этим же процессом (см.
  //    recreateBackendDetached ниже — второй пойманный вживую инцидент, 2026-08-04, научил,
  //    что просто "поставить backend последним" недостаточно).
  // 4. nginx настроен на резолвинг backend/frontend через встроенный DNS докера с TTL
  //    (см. nginx.conf) — при пересоздании backend/frontend в последнюю очередь nginx
  //    сам переспросит их новый IP по истечении TTL, без необходимости его перезапускать.
  private async runUpdateSequence(repoPath: string, logPath: string): Promise<void> {
    const emit = (percent: number, step: string) => this.systemGateway.broadcastUpdateProgress({ percent, step, done: false });
    try {
      emit(5, 'git pull');
      await this.runLogged('git pull', repoPath, logPath);

      emit(15, 'Сборка образов backend и frontend');
      await this.runLogged('docker compose build backend frontend', repoPath, logPath);

      emit(60, 'Пересоздание nginx и frontend');
      await this.runLogged('docker compose up -d --force-recreate --no-deps nginx frontend', repoPath, logPath);

      emit(85, 'Запуск пересоздания backend в отдельном служебном контейнере — соединение сейчас оборвётся, это ожидаемо');
      await this.recreateBackendDetached(repoPath, logPath);

      this.systemGateway.broadcastUpdateProgress({ percent: 100, step: 'Готово', done: true });
    } catch (error) {
      this.systemGateway.broadcastUpdateProgress({
        percent: 100,
        step: 'Ошибка',
        done: true,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // Реальный повторный инцидент (2026-08-04): "docker compose up -d --no-deps backend",
  // запущенный обычным дочерним процессом ЭТОГО ЖЕ backend-процесса, сам является клиентом
  // docker-демона, посылающим ПОСЛЕДОВАТЕЛЬНОСТЬ запросов (stop → rm → create → start).
  // Когда демон останавливает старый backend-контейнер (первый шаг этой последовательности),
  // убивается вся его cgroup/pid namespace — включая сам процесс docker compose, который эту
  // последовательность и вёл. Итог: старый контейнер остановлен и удалён, а создать и
  // запустить новый уже некому — backend остаётся недоступен до ручного "docker compose up
  // -d" по SSH. Простое "поставить backend последним шагом" эту гонку не устраняет, потому
  // что причина не в порядке шагов, а в том, что оркестратор пересоздания и его цель — один
  // и тот же контейнер.
  //
  // Фикс: финальный шаг выполняет НЕ этот процесс, а независимый sibling-контейнер,
  // запущенный через тот же смонтированный docker.sock (`docker run -d --rm`). Такой
  // контейнер не входит в cgroup/pid namespace backend'а — это просто ещё один контейнер на
  // хосте, знающий про backend не больше, чем про любой другой сосед по демону. Убийство
  // backend-контейнера его никак не касается: он спокойно доводит "docker compose up" до
  // конца сам, уже после того как текущий процесс мог быть убит. `docker run -d` возвращает
  // управление сразу после того, как sibling-контейнер СОЗДАН И ЗАПУЩЕН демоном — то есть эта
  // функция успевает успешно завершиться и передать управление обратно в runUpdateSequence
  // ДО того, как что-либо внутри sibling-контейнера (включая `sleep 2`) успеет остановить
  // текущий backend.
  private async recreateBackendDetached(repoPath: string, logPath: string): Promise<void> {
    const containerId = os.hostname();
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.Image}}', containerId]);
    const selfImage = stdout.trim();

    const helperCommand = `sleep 2 && docker compose up -d --no-deps backend >> "${logPath}" 2>&1`;
    await execFileAsync('docker', [
      'run',
      '-d',
      '--rm',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${repoPath}:${repoPath}`,
      '-w',
      repoPath,
      selfImage,
      'sh',
      '-c',
      helperCommand,
    ]);
  }

  private runLogged(command: string, cwd: string, logPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = exec(`${command} >> "${logPath}" 2>&1`, { cwd, env: { ...process.env, PWD: cwd } });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`"${command}" завершилась с кодом ${code}`))));
    });
  }

  private async git(repoPath: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
    return stdout.trim();
  }
}
