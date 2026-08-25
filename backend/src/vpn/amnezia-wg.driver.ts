import { randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { NodeSSH } from 'node-ssh';
import { VpnProtocol } from '../common/enums';
import { SshService } from '../ssh/ssh.service';
import { BaseWireGuardLikeDriver } from './base-wireguard-like.driver';

/**
 * AmneziaWG — форк WireGuard с обфускацией трафика (Jc/Jmin/Jmax/S1/S2/H1-H4).
 * Требует установки пакета из PPA amnezia (см. README) и совместимого ядра —
 * на части VPS-провайдеров (кастомные ядра без dkms) установка может не пройти,
 * тогда протокол для этого сервера помечается статусом error с текстом ошибки.
 */
@Injectable()
export class AmneziaWgDriver extends BaseWireGuardLikeDriver {
  readonly protocol = VpnProtocol.AMNEZIAWG;
  protected readonly binary = 'awg';
  protected readonly quickBinary = 'awg-quick';
  protected readonly confDir = '/etc/amnezia/amneziawg';
  protected readonly defaultInterfaceName = 'awg0';
  protected readonly containerNameHints = ['amnezia-awg', 'amnezia-amneziawg'];
  protected readonly aptPackages = 'amneziawg amneziawg-tools';

  constructor(sshService: SshService) {
    super(sshService);
  }

  // См. комментарий в WireGuardDriver.ensureClientToolsInstalled — тут это ещё важнее:
  // без проверки при КАЖДОМ переключении upstream гонялись бы два apt-get update и
  // add-apt-repository (сеть + PPA), даже если awg-tools давно установлен.
  async ensureClientToolsInstalled(ssh: NodeSSH): Promise<void> {
    const check = await this.sshService.exec(ssh, 'command -v awg-quick');
    if (check.code === 0) {
      return;
    }
    await this.ensureIpv4NetworkPreferred(ssh);
    try {
      await this.sshService.execOrThrow(
        ssh,
        [
          'export DEBIAN_FRONTEND=noninteractive',
          'apt-get update -y',
          'apt-get install -y software-properties-common',
          'add-apt-repository -y ppa:amnezia/ppa',
          'apt-get update -y',
          `apt-get install -y ${this.aptPackages} iptables`,
        ].join(' && '),
      );
    } catch (error) {
      throw this.withPpaReleaseHint(error as Error);
    }
  }

  // `add-apt-repository -y ppa:amnezia/ppa` подставляет ТЕКУЩИЙ кодовое имя релиза Ubuntu
  // (`lsb_release -cs`) в добавляемый источник — если сторонний PPA (поддерживается
  // энтузиастами, не Canonical) ещё не опубликовал сборку под этот конкретный релиз
  // (обычно самый свежий, вышедший недавно), apt-get update валится с "does not have a
  // Release file" именно для этого источника. Это внешнее ограничение (см. README
  // "Известные ограничения MVP"), не чинится кодом панели — но подменить кодовое имя в уже
  // добавленном источнике на заведомо поддерживаемое (LTS) обычно безопасно и работает:
  // сам DKMS-модуль всё равно собирается против РЕАЛЬНЫХ заголовков запущенного ядра, а не
  // против кодового имени релиза — то есть источник просто описывает, ОТКУДА тянуть .deb,
  // а не то, под что они бинарно завязаны.
  private withPpaReleaseHint(error: Error): Error {
    const match = error.message.match(/ubuntu ([a-z0-9.]+)[^']*'? does not have a Release file/i);
    if (!match) {
      return error;
    }
    const codename = match[1];
    const hint =
      `PPA ppa:amnezia/ppa (сторонний, поддерживается энтузиастами, не Canonical) ещё не ` +
      `опубликовал сборку для релиза Ubuntu "${codename}" — вероятно, это совсем свежий релиз. ` +
      `Варианты: 1) подождать, пока мейнтейнеры PPA добавят сборку под "${codename}"; ` +
      `2) зайти по SSH и подменить кодовое имя в уже добавленном источнике на заведомо ` +
      `поддерживаемый LTS-релиз, например: "sed -i 's/${codename}/noble/' ` +
      `/etc/apt/sources.list.d/amnezia-ubuntu-ppa-*.list && apt-get update" — и повторить ` +
      `установку из панели (обычно работает: DKMS-модуль собирается под реальное ядро сервера, ` +
      `не под кодовое имя релиза в источнике apt); 3) использовать WireGuard — он ставится из ` +
      `официальных репозиториев Ubuntu и от этого PPA не зависит.`;
    return new Error(`${error.message}\n\n${hint}`);
  }

  // Полный набор параметров AmneziaWG 3.0 (Jc/Jmin/Jmax/S1-S4/H1-H4-как-диапазоны) —
  // генерируется ТОЛЬКО для НОВЫХ установок протокола (install() вызывает этот метод один
  // раз, результат сохраняется в ServerProtocol.obfuscationParams и оттуда уже неизменно
  // применяется на сервере и во всех клиентских конфигах этого протокола, см.
  // base-wireguard-like.driver.ts). Уже установленные протоколы этот код не трогает —
  // их obfuscationParams остаётся тем, что было сгенерировано при их собственной
  // установке (может быть старым, "Legacy"-набором без S3/S4/диапазонов H — намеренно
  // не мигрируем существующие интерфейсы автоматически: у AmneziaWG эти параметры общие
  // на весь интерфейс, а не per-peer, рассинхронизация со старыми уже выданными клиентскими
  // конфигами оборвала бы им handshake). Чтобы получить новый набор на уже установленном
  // сервере — переустановить протокол (Server.protocols → «Удалить протокол» → установить
  // заново), но только если на этом сервере нет других активных peers этого протокола,
  // кроме системного upstream-peer моста — иначе их обфускация перестанет совпадать с
  // сервером и они отвалятся. Значения и диапазоны сверены с проверенным community-скриптом
  // (bivlked/amneziawg-installer, awg_common_en.sh/install_amneziawg_en.sh) — единственным
  // найденным источником, где эти диапазоны реально протестированы на живых серверах.
  protected buildObfuscationParams(): Record<string, number | string> {
    const jmin = randomInt(40, 90);
    return {
      Jc: randomInt(3, 7),
      Jmin: jmin,
      Jmax: jmin + randomInt(50, 251),
      S1: randomInt(15, 151),
      S2: randomInt(15, 151),
      S3: randomInt(8, 56),
      S4: randomInt(4, 28),
      ...this.buildHRanges(),
    };
  }

  // 4 непересекающихся диапазона "min-max" для H1-H4 — нижняя граница первого диапазона
  // >= 5 (1-4 зарезервированы под типы сообщений ванильного WireGuard), между соседними
  // диапазонами зазор минимум 1000, верхняя граница ограничена 2^31-1 (не полным uint32) —
  // отдельные клиенты AmneziaWG (в частности Windows) валидируют H-поля как signed int32 и
  // отклоняют большие значения, хотя сам сервер принял бы полный uint32.
  private buildHRanges(): Record<'H1' | 'H2' | 'H3' | 'H4', string> {
    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const values = Array.from({ length: 8 }, () => randomInt(0, 2 ** 31 - 1)).sort((a, b) => a - b);
      const validPair = (loIdx: number, hiIdx: number) => values[hiIdx] - values[loIdx] >= 1000;
      if (
        values[0] >= 5 &&
        validPair(0, 1) &&
        validPair(2, 3) &&
        validPair(4, 5) &&
        validPair(6, 7) &&
        values[2] > values[1] &&
        values[4] > values[3] &&
        values[6] > values[5]
      ) {
        return {
          H1: `${values[0]}-${values[1]}`,
          H2: `${values[2]}-${values[3]}`,
          H3: `${values[4]}-${values[5]}`,
          H4: `${values[6]}-${values[7]}`,
        };
      }
    }
    throw new Error('Не удалось сгенерировать непересекающиеся диапазоны H1-H4 для AmneziaWG за разумное число попыток');
  }

  // AmneziaWG 2.0 добавляет S3/S4, а H1-H4 там может быть диапазоном "min-max" вместо
  // одного числа — значение сохраняем как есть (числом, если это просто число, иначе строкой).
  protected parseObfuscationParamsFromConfig(configText: string): Record<string, number | string> | undefined {
    const keys = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4'];
    const result: Record<string, number | string> = {};
    for (const key of keys) {
      const match = configText.match(new RegExp(`^${key}\\s*=\\s*(\\S+)`, 'm'));
      if (match) {
        const raw = match[1];
        result[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
}
