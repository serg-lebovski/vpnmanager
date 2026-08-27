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

// "amnezia-awg" — тот же container id, что и сам официальный клиент подставляет при
// ИМПОРТЕ стороннего .conf (ImportController::extractWireGuardConfig в исходниках
// amnezia-client: определяет протокол по наличию awg-полей, но container всегда
// "amnezia-awg", "amnezia-awg2" в этом пути НЕ используется вообще — тот id зарезервирован
// за собственной server-management логикой приложения, не за третьесторонним импортом).
// Раньше здесь была попытка отличать "amnezia-awg2" по наличию S3 в obfuscationParams —
// убрано: это не тот код, который реально грузит и коннектит сторонние .vpn-профили,
// подтверждено вживую (профиль с "amnezia-awg2" не подключался вообще, ни разу).
function amneziaContainerId(protocol: VpnProtocol): string {
  return protocol === VpnProtocol.AMNEZIAWG ? 'amnezia-awg' : 'amnezia-wireguard';
}

// AwgClientConfig::fromJson/AwgServerConfig::fromJson (и их WireGuard-аналоги) в
// исходниках amnezia-client читают mtu/persistentKeepAlive/Jc/Jmin/Jmax/S1-S4/H1-H4 через
// Qt QJsonValue::toString() — а toString() возвращает ПУСТУЮ строку, если значение хранится
// как JSON-число, а не строка (Qt не делает неявное приведение типа при чтении JSON).
// serverProtocol.obfuscationParams хранит Jc/Jmin/Jmax/S1/S2 как числа (см.
// AmneziaWgDriver.buildObfuscationParams) — без явного приведения к строке здесь ВСЕ эти
// поля читались бы приложением как пустые, и AmneziaWG получал бы нулевые/дефолтные
// параметры обфускации, не совпадающие с реальными на сервере — сервер ожидает junk-
// обрамление пакетов по этим параметрам, соединение просто не устанавливается (подтверждено
// вживую: WireGuard, у которого таких полей нет вообще, подключался нормально; AmneziaWG —
// нет, ни разу, до этого фикса). port — исключение: там ОБРАТНО, .toInt() в
// last_config.port ожидает именно число, а не строку.
function toAmneziaStringField(value: number | string): string {
  return String(value);
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
    mtu: toAmneziaStringField(mtu),
    persistent_keep_alive: toAmneziaStringField(25),
    port: serverProtocol.listenPort,
    psk_key: presharedKey ?? '',
    server_pub_key: serverProtocol.serverPublicKey ?? '',
  };

  const protocolBlock: Record<string, unknown> = {
    port: String(serverProtocol.listenPort),
    transport_proto: 'udp',
    // Без этого поля импортированный профиль не подключается вообще (ни WireGuard, ни
    // AmneziaWG) — приложение просто не отправляет ни одного пакета на сервер (проверено
    // вживую: tcpdump на сервере не видел ни одного входящего пакета при попытке
    // подключения без этого поля). Это тот же флаг, который сам клиент проставляет себе
    // при импорте СТОРОННЕГО .conf (см. amneziaContainerId) — без него приложение,
    // похоже, обрабатывает профиль как "свой", ожидая полей/состояния, которых там нет,
    // и просто не поднимает туннель.
    isThirdPartyConfig: true,
  };

  // Jc/Jmin/... нужны И на верхнем уровне блока протокола (читает AwgServerConfig::fromJson
  // — используется для определения версии AWG/отображения), И внутри last_config (читает
  // AwgClientConfig::fromJson — используется для реального подключения) — оба места читают
  // независимо друг от друга, оба через toString().
  if (protocol === VpnProtocol.AMNEZIAWG && serverProtocol.obfuscationParams) {
    const stringified = Object.fromEntries(
      Object.entries(serverProtocol.obfuscationParams).map(([key, value]) => [key, toAmneziaStringField(value)]),
    );
    Object.assign(protocolBlock, stringified);
    Object.assign(lastConfig, stringified);
  }
  protocolBlock.last_config = JSON.stringify(lastConfig);

  const protocolKey = protocol === VpnProtocol.AMNEZIAWG ? 'awg' : 'wireguard';

  return { container: amneziaContainerId(protocol), [protocolKey]: protocolBlock };
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
    defaultContainer: amneziaContainerId(primary.protocol),
    description,
    dns1: primary.peer.dns,
    dns2: primary.peer.dns,
    hostName: primary.server.host,
  };
  return encodeVpnConfig(payload);
}
