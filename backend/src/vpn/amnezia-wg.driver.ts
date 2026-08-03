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
    await this.sshService.execOrThrow(
      ssh,
      [
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -y',
        'apt-get install -y software-properties-common',
        'add-apt-repository -y ppa:amnezia/ppa',
        'apt-get update -y',
        'apt-get install -y amneziawg amneziawg-tools iptables',
      ].join(' && '),
    );
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
