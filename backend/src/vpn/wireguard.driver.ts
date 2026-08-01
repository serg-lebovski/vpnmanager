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

  async ensureClientToolsInstalled(ssh: NodeSSH): Promise<void> {
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
