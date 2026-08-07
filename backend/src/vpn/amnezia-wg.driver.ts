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

  protected buildObfuscationParams(): Record<string, number> {
    const usedValues = new Set<number>();
    const nextUniqueValue = (): number => {
      let value: number;
      do {
        value = randomInt(5, 2 ** 31 - 1);
      } while (usedValues.has(value));
      usedValues.add(value);
      return value;
    };

    return {
      Jc: randomInt(3, 10),
      Jmin: 40,
      Jmax: 70,
      S1: randomInt(15, 150),
      S2: randomInt(15, 150),
      H1: nextUniqueValue(),
      H2: nextUniqueValue(),
      H3: nextUniqueValue(),
      H4: nextUniqueValue(),
    };
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
