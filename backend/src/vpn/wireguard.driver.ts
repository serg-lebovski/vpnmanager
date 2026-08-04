import { Injectable } from '@nestjs/common';
import { NodeSSH } from 'node-ssh';
import { VpnProtocol } from '../common/enums';
import { SshService } from '../ssh/ssh.service';
import { BaseWireGuardLikeDriver } from './base-wireguard-like.driver';

@Injectable()
export class WireGuardDriver extends BaseWireGuardLikeDriver {
  readonly protocol = VpnProtocol.WIREGUARD;
  protected readonly binary = 'wg';
  protected readonly quickBinary = 'wg-quick';
  protected readonly confDir = '/etc/wireguard';
  protected readonly defaultInterfaceName = 'wg0';
  protected readonly containerNameHints = ['amnezia-wireguard', 'amnezia-wg'];

  constructor(sshService: SshService) {
    super(sshService);
  }

  // Раньше гоняли apt-get на КАЖДОЕ переключение upstream, даже если всё уже стоит — это
  // и есть основная причина "долгого переключения" (apt-get update занимает секунды-
  // десятки секунд сам по себе). Проверяем наличие бинарника и выходим сразу, если он уже
  // есть — apt/сеть трогаем только при первом реальном использовании self-сервера с этим
  // протоколом.
  async ensureClientToolsInstalled(ssh: NodeSSH): Promise<void> {
    const check = await this.sshService.exec(ssh, 'command -v wg-quick');
    if (check.code === 0) {
      return;
    }
    await this.ensureIpv4NetworkPreferred(ssh);
    await this.sshService.execOrThrow(
      ssh,
      'export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install -y wireguard wireguard-tools iptables',
    );
  }

  protected buildObfuscationParams(): undefined {
    return undefined;
  }

  protected parseObfuscationParamsFromConfig(): undefined {
    return undefined;
  }
}
