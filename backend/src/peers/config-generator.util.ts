import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { Peer } from './peer.entity';

export function buildClientConfig(
  peer: Peer,
  privateKey: string,
  server: Server,
  serverProtocol: ServerProtocol,
  presharedKey?: string | null,
): string {
  const lines: string[] = [];
  lines.push('[Interface]');
  lines.push(`PrivateKey = ${privateKey}`);
  lines.push(`Address = ${peer.allowedIp}/32`);
  lines.push(`DNS = ${peer.dns}`);
  if (serverProtocol.mtu) {
    lines.push(`MTU = ${serverProtocol.mtu}`);
  }
  if (serverProtocol.obfuscationParams) {
    for (const [key, value] of Object.entries(serverProtocol.obfuscationParams)) {
      lines.push(`${key} = ${value}`);
    }
  }
  lines.push('');
  lines.push('[Peer]');
  lines.push(`PublicKey = ${serverProtocol.serverPublicKey}`);
  if (presharedKey) {
    lines.push(`PresharedKey = ${presharedKey}`);
  }
  lines.push(`Endpoint = ${server.host}:${serverProtocol.listenPort}`);
  lines.push('AllowedIPs = 0.0.0.0/0, ::/0');
  lines.push('PersistentKeepalive = 25');
  return lines.join('\n') + '\n';
}
