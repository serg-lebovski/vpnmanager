import { deflateSync } from 'zlib';
import { VpnProtocol } from '../common/enums';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { buildClientConfig } from './config-generator.util';
import { Peer } from './peer.entity';

// Формат официального приложения AmneziaVPN (файл .vpn / ссылка "vpn://..."): JSON с
// массивом "containers" (по одному на протокол) кодируется как vpn://<base64url> —
// zlib-deflate(JSON) с 4-байтовым big-endian заголовком (длина ИСХОДНОГО JSON до сжатия,
// это ровно формат Qt qCompress/qUncompress, которым пользуется сам клиент). Поля и имена
// Docker-контейнеров ("amnezia-wireguard"/"amnezia-awg") сверены с открытым исходным кодом
// клиента (amnezia-vpn/amnezia-client, core/utils/constants/configKeys.h,
// core/utils/containers/containerUtils.cpp) и с независимой реализацией того же кодирования
// (kyoresuas/amnezia-api, helpers/encodeVpnConfig.ts) — сам этот бэкенд никогда не общается
// с приложением напрямую, только генерирует файл, поэтому побайтовая сверка возможна лишь
// импортом получившегося файла в реальном приложении.
function encodeVpnConfig(payload: unknown): string {
  const rawData = Buffer.from(JSON.stringify(payload), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(rawData.length, 0);
  const compressed = deflateSync(rawData, { level: 8 });
  const base64url = Buffer.concat([header, compressed])
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `vpn://${base64url}`;
}

export interface AmneziaContainerInput {
  protocol: VpnProtocol;
  peer: Peer;
  privateKey: string;
  presharedKey: string | null;
  server: Server;
  serverProtocol: ServerProtocol;
}

function buildContainerEntry(input: AmneziaContainerInput): Record<string, unknown> {
  const { protocol, peer, privateKey, presharedKey, server, serverProtocol } = input;
  const configText = buildClientConfig(peer, privateKey, server, serverProtocol, presharedKey);
  const mtu = serverProtocol.mtu ?? (protocol === VpnProtocol.AMNEZIAWG ? 1280 : 1420);

  const lastConfig: Record<string, unknown> = {
    allowed_ips: ['0.0.0.0/0', '::/0'],
    clientId: peer.publicKey,
    client_ip: peer.allowedIp,
    client_priv_key: privateKey,
    client_pub_key: peer.publicKey,
    config: configText,
    hostName: server.host,
    mtu,
    persistent_keep_alive: 25,
    port: serverProtocol.listenPort,
    psk_key: presharedKey ?? '',
    server_pub_key: serverProtocol.serverPublicKey ?? '',
  };

  const protocolBlock: Record<string, unknown> = {
    port: String(serverProtocol.listenPort),
    transport_proto: 'udp',
  };

  if (protocol === VpnProtocol.AMNEZIAWG && serverProtocol.obfuscationParams) {
    Object.assign(protocolBlock, serverProtocol.obfuscationParams);
    Object.assign(lastConfig, serverProtocol.obfuscationParams);
  }
  protocolBlock.last_config = JSON.stringify(lastConfig);

  const containerId = protocol === VpnProtocol.AMNEZIAWG ? 'amnezia-awg' : 'amnezia-wireguard';
  const protocolKey = protocol === VpnProtocol.AMNEZIAWG ? 'awg' : 'wireguard';

  return { container: containerId, [protocolKey]: protocolBlock };
}

// description — то, что приложение покажет как имя профиля; hostName/dns — общие для
// профиля в целом (не на каждый контейнер отдельно) поля верхнего уровня формата.
export function buildAmneziaAppConfig(
  containers: AmneziaContainerInput[],
  description: string,
  preferredDefaultProtocol: VpnProtocol = VpnProtocol.AMNEZIAWG,
): string {
  if (containers.length === 0) {
    throw new Error('Нужен хотя бы один протокол для конфига AmneziaVPN');
  }
  const primary = containers.find((c) => c.protocol === preferredDefaultProtocol) ?? containers[0];
  const payload = {
    containers: containers.map(buildContainerEntry),
    defaultContainer: primary.protocol === VpnProtocol.AMNEZIAWG ? 'amnezia-awg' : 'amnezia-wireguard',
    description,
    dns1: primary.peer.dns,
    dns2: primary.peer.dns,
    hostName: primary.server.host,
  };
  return encodeVpnConfig(payload);
}
