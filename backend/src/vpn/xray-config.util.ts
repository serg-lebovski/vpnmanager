import { XrayRoutingOptions } from '../servers/server-protocol.entity';

// Зафиксированные версии — не "latest": установка на сервер должна быть воспроизводимой, а
// формат конфига Xray между мажорными версиями иногда меняется (поймано вживую на тестовом
// стенде: sing-box 1.14 не проходил Reality-аутентификацию против Xray 26 — поэтому и на
// сервере, и на клиенте моста используется один и тот же Xray). Обновление — осознанная
// правка этих констант + проверка на тестовом сервере.
export const XRAY_VERSION = '26.11.9';
export const HEV_SOCKS5_TUNNEL_VERSION = '2.20.0';

// Сайт маскировки Reality по умолчанию: нужен TLS 1.3 + HTTP/2 и доступность из РФ;
// www.microsoft.com/www.apple.com Xray сам помечает как повышающие риск блокировки.
export const DEFAULT_REALITY_SNI = 'dl.google.com';
export const VLESS_FLOW = 'xtls-rprx-vision';
export const REALITY_FINGERPRINT = 'chrome';
export const XRAY_INBOUND_TAG = 'vless-in';

export const XRAY_BINARY = '/usr/local/bin/xray';
export const HEV_BINARY = '/usr/local/bin/hev-socks5-tunnel';
export const XRAY_CONF_DIR = '/etc/vpnmanager/xray';

// Частные/служебные сети — клиенты VLESS-сервера не должны через него ходить внутрь самого
// хоста (127.0.0.1 — API Xray, docker-сети панели с Postgres и т.п.) и в его локальные сети.
// Явный список вместо geoip:private — не зависим от наличия geoip.dat на сервере.
export const PRIVATE_NETWORKS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

// Резолверы для доменов из списка обхода моста (их трафик идёт напрямую с self-сервера —
// и резолвить их нужно "по-местному", иначе CDN отдаст зарубежные адреса) и для всего
// остального (через upstream-туннель).
export const DIRECT_DNS_SERVERS = ['77.88.8.8', '77.88.8.1'];
export const TUNNEL_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

// Параметры Reality/Xray, которые не являются секретом и нужны для генерации клиентских
// ссылок — хранятся в ServerProtocol.obfuscationParams (приватный ключ Reality живёт только
// в конфиге на самом сервере, как приватный ключ WireGuard).
// Транспорт VLESS:
// - reality — свой TCP-порт наружу, TLS-маскировка Reality под чужой сайт (sni/shortId).
// - xhttp — только на сервере ПАНЕЛИ: Xray слушает внутренний адрес docker-шлюза без TLS, а
//   наружу его отдаёт nginx панели на 443 с НАСТОЯЩИМ сертификатом домена панели по
//   секретному пути (см. NginxConfigService). Для DPI это неотличимо от открытия панели в
//   браузере — пойманный вживую случай 2026-11-14: домашний провайдер обрезал рукопожатия
//   Reality на любом порту/SNI, а обычный HTTPS той же панели проходил.
export type VlessTransport = 'reality' | 'xhttp';

export interface VlessServerParams {
  transport: VlessTransport;
  fingerprint: string;
  flow: string;
  apiPort: number;
  // reality
  sni?: string;
  shortId?: string;
  // xhttp
  path?: string;
  domain?: string;
  publicPort?: number;
  listenAddress?: string;
}

export function parseVlessServerParams(raw: Record<string, number | string> | null | undefined): VlessServerParams {
  const transport: VlessTransport = raw?.transport === 'xhttp' ? 'xhttp' : 'reality';
  if (transport === 'xhttp') {
    if (!raw || typeof raw.path !== 'string' || typeof raw.domain !== 'string' || typeof raw.listenAddress !== 'string') {
      throw new Error('У VLESS (XHTTP) нет параметров path/domain — переустановите протокол');
    }
    return {
      transport,
      fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : REALITY_FINGERPRINT,
      flow: '',
      apiPort: Number(raw.apiPort),
      path: raw.path,
      domain: raw.domain,
      publicPort: Number(raw.publicPort) || 443,
      listenAddress: raw.listenAddress,
    };
  }
  if (!raw || typeof raw.sni !== 'string' || typeof raw.shortId !== 'string') {
    throw new Error('У VLESS-протокола нет параметров Reality (sni/shortId) — переустановите протокол');
  }
  return {
    transport,
    sni: raw.sni,
    shortId: raw.shortId,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : REALITY_FINGERPRINT,
    flow: typeof raw.flow === 'string' ? raw.flow : VLESS_FLOW,
    apiPort: Number(raw.apiPort),
  };
}

export function xrayServerUnitName(interfaceName: string): string {
  return `vpnmanager-xray-${interfaceName}`;
}

export function xrayClientUnitName(interfaceName: string): string {
  return `vpnmanager-xrayc-${interfaceName}`;
}

export function tunUnitName(interfaceName: string): string {
  return `vpnmanager-tun-${interfaceName}`;
}

export function xrayServerConfigPath(interfaceName: string): string {
  return `${XRAY_CONF_DIR}/${interfaceName}.json`;
}

export function xrayClientConfigPath(interfaceName: string): string {
  return `${XRAY_CONF_DIR}/${interfaceName}-client.json`;
}

export function tunConfigPath(interfaceName: string): string {
  return `${XRAY_CONF_DIR}/${interfaceName}-tun.yml`;
}

// Локальный SOCKS-порт клиента моста и адрес его TUN — производные от routeTable моста:
// уникальны для каждого моста на одном self-сервере (routeTable уникален, см.
// BridgesService.allocateRouteTable) без отдельного хранения в БД.
export function bridgeSocksPort(routeTable: number): number {
  return 40000 + (routeTable % 10000);
}

export function bridgeTunAddress(routeTable: number): string {
  return `198.18.${routeTable % 250}.1`;
}

export interface XrayServerConfigInput {
  listenPort: number;
  apiPort: number;
  // Только для reality (для xhttp TLS делает nginx, ключа у Xray нет).
  privateKey: string;
  params: Pick<VlessServerParams, 'sni' | 'shortId' | 'flow'> & Partial<Pick<VlessServerParams, 'transport' | 'path' | 'listenAddress'>>;
  clients: Array<{ uuid: string; email: string }>;
  routing?: XrayRoutingOptions | null;
}

function vlessInboundTransport(input: XrayServerConfigInput): { listen: string; streamSettings: Record<string, unknown> } {
  if (input.params.transport === 'xhttp') {
    return {
      listen: input.params.listenAddress!,
      streamSettings: { network: 'xhttp', security: 'none', xhttpSettings: { path: input.params.path, mode: 'auto' } },
    };
  }
  return {
    listen: '0.0.0.0',
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        show: false,
        target: `${input.params.sni}:443`,
        serverNames: [input.params.sni],
        privateKey: input.privateKey,
        shortIds: [input.params.shortId],
      },
    },
  };
}

export function renderXrayServerConfig(input: XrayServerConfigInput): Record<string, unknown> {
  const routing = input.routing ?? null;
  const transport = vlessInboundTransport(input);
  const viaBridge = typeof routing?.mark === 'number' && routing.mark > 0;
  const directDomains = routing?.directDomains ?? [];
  const directIps = routing?.directIps ?? [];

  const outbounds: Array<Record<string, unknown>> = [];
  if (viaBridge) {
    // Первый outbound — маршрут по умолчанию: всё, что не попало в правила ниже, уходит в
    // upstream-туннель моста (fwmark → `ip rule fwmark <mark> lookup <routeTable>`).
    // domainStrategy — в sockopt (в Xray 26 freedom.settings.domainStrategy объявлен
    // устаревшим): резолвить домены собственным DNS Xray (см. config.dns ниже).
    outbounds.push({
      tag: 'via-bridge',
      protocol: 'freedom',
      streamSettings: { sockopt: { mark: routing!.mark, domainStrategy: 'UseIPv4' } },
    });
    outbounds.push({ tag: 'direct', protocol: 'freedom', streamSettings: { sockopt: { domainStrategy: 'UseIPv4' } } });
  } else {
    outbounds.push({ tag: 'direct', protocol: 'freedom' });
  }
  outbounds.push({ tag: 'block', protocol: 'blackhole' });

  const rules: Array<Record<string, unknown>> = [{ type: 'field', ip: PRIVATE_NETWORKS, outboundTag: 'block' }];
  if (viaBridge) {
    rules.push({ type: 'field', ip: DIRECT_DNS_SERVERS, outboundTag: 'direct' });
    if (directDomains.length > 0) {
      rules.push({ type: 'field', domain: directDomains.map((domain) => `domain:${domain}`), outboundTag: 'direct' });
    }
    if (directIps.length > 0) {
      rules.push({ type: 'field', ip: directIps, outboundTag: 'direct' });
    }
  }

  const config: Record<string, unknown> = {
    log: { loglevel: 'warning' },
    api: { tag: 'api', listen: `127.0.0.1:${input.apiPort}`, services: ['HandlerService', 'StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
    },
    inbounds: [
      {
        tag: XRAY_INBOUND_TAG,
        listen: transport.listen,
        port: input.listenPort,
        protocol: 'vless',
        settings: {
          clients: input.clients.map((client) =>
            input.params.flow ? { id: client.uuid, email: client.email, flow: input.params.flow } : { id: client.uuid, email: client.email },
          ),
          decryption: 'none',
        },
        streamSettings: transport.streamSettings,
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
      },
    ],
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  };

  if (viaBridge) {
    // Собственный DNS Xray (domainStrategy UseIPv4 выше): системный резолвер self-сервера
    // ходит мимо туннеля и может вернуть подменённые/"местные" ответы для заблокированных
    // доменов. Домены обхода резолвим российским DNS напрямую (правило выше на его IP),
    // остальное — публичным DNS через upstream-туннель (дефолтный outbound).
    const servers: Array<string | Record<string, unknown>> = [];
    if (directDomains.length > 0) {
      for (const address of DIRECT_DNS_SERVERS) {
        servers.push({ address, domains: directDomains.map((domain) => `domain:${domain}`), skipFallback: true });
      }
    }
    servers.push(...TUNNEL_DNS_SERVERS);
    config.dns = { servers, queryStrategy: 'UseIPv4' };
  }

  return config;
}

// Пользователи VLESS-инбаунда из уже лежащего на сервере конфига — для расчёта разницы
// (кого добавить/удалить через API Xray без перезапуска, см. XrayDriver.applyPeers).
export function extractXrayClients(config: unknown): Array<{ uuid: string; email: string }> {
  const inbounds = (config as { inbounds?: Array<Record<string, any>> } | null)?.inbounds ?? [];
  const inbound = inbounds.find((item) => item?.tag === XRAY_INBOUND_TAG);
  const clients = (inbound?.settings?.clients ?? []) as Array<{ id?: unknown; email?: unknown }>;
  return clients
    .filter((client) => typeof client.id === 'string' && typeof client.email === 'string')
    .map((client) => ({ uuid: client.id as string, email: client.email as string }));
}

// Конфиг без списка пользователей — сравнивается старый и новый, чтобы понять, хватит ли
// горячего добавления/удаления пользователей через API или поменялось что-то ещё (маршруты,
// ключи, порт) и Xray нужно перезапустить.
export function xrayConfigWithoutClients(config: unknown): string {
  const clone = JSON.parse(JSON.stringify(config ?? {}));
  for (const inbound of clone.inbounds ?? []) {
    if (inbound?.settings?.clients) {
      inbound.settings.clients = [];
    }
  }
  return JSON.stringify(clone);
}

export interface XrayClientConfigInput {
  socksPort: number;
  host: string;
  port: number;
  uuid: string;
  publicKey: string;
  params: Pick<VlessServerParams, 'sni' | 'shortId' | 'fingerprint' | 'flow'>;
}

// Клиент моста: локальный SOCKS (к нему подключается hev-socks5-tunnel, см. renderTunConfig)
// → VLESS+Reality до upstream-сервера.
export function renderXrayClientConfig(input: XrayClientConfigInput): Record<string, unknown> {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port: input.socksPort,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' },
      },
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: input.host,
              port: input.port,
              users: [{ id: input.uuid, encryption: 'none', flow: input.params.flow }],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            serverName: input.params.sni,
            publicKey: input.publicKey,
            shortId: input.params.shortId,
            fingerprint: input.params.fingerprint,
          },
        },
      },
    ],
  };
}

// hev-socks5-tunnel поднимает TUN с ИМЕНЕМ upstream-интерфейса моста — вся остальная
// маршрутизация моста (routeTable, NAT, MSS-клампинг, Telegram/MTProxy-метки) ссылается
// именно на это имя и работает без изменений, как с WG/AWG upstream.
export function renderTunConfig(input: { interfaceName: string; socksPort: number; tunAddress: string }): string {
  return [
    'tunnel:',
    `  name: ${input.interfaceName}`,
    '  mtu: 1500',
    `  ipv4: ${input.tunAddress}`,
    'socks5:',
    `  port: ${input.socksPort}`,
    '  address: 127.0.0.1',
    "  udp: 'udp'",
    'misc:',
    '  log-level: warn',
    '',
  ].join('\n');
}

export function renderSystemdUnit(input: {
  description: string;
  execStart: string;
  execStartPost?: string;
  after?: string;
  bindsTo?: string;
}): string {
  const lines = ['[Unit]', `Description=${input.description}`, `After=network-online.target${input.after ? ` ${input.after}` : ''}`];
  lines.push('Wants=network-online.target');
  if (input.bindsTo) {
    lines.push(`BindsTo=${input.bindsTo}`);
  }
  lines.push(
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${input.execStart}`,
    ...(input.execStartPost ? [`ExecStartPost=${input.execStartPost}`] : []),
    'Restart=always',
    'RestartSec=3',
    // hev-socks5-tunnel может не реагировать на SIGTERM — без этого systemd ждал бы 90с
    // перед SIGKILL, и столько же висело бы переключение upstream.
    'TimeoutStopSec=5',
    'LimitNOFILE=1048576',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  );
  return lines.join('\n');
}

export function buildVlessUri(input: {
  uuid: string;
  host: string;
  port: number;
  publicKey: string;
  params: Pick<VlessServerParams, 'sni' | 'shortId' | 'fingerprint' | 'flow'> &
    Partial<Pick<VlessServerParams, 'transport' | 'path' | 'domain' | 'publicPort'>>;
  name: string;
}): string {
  if (input.params.transport === 'xhttp') {
    // Клиент ходит на домен ПАНЕЛИ (её сертификат) на 443 — host/port из аргументов (адрес
    // self-сервера/домен моста) тут не подходят: сертификат выпущен именно на домен панели.
    // alpn=http/1.1 + mode=packet-up — nginx панели отдаёт HTTP/1.1 (без http2), а
    // packet-up — единственный режим XHTTP, работающий через обычный HTTP/1.1-прокси.
    const query = new URLSearchParams({
      type: 'xhttp',
      security: 'tls',
      encryption: 'none',
      sni: input.params.domain!,
      host: input.params.domain!,
      path: input.params.path!,
      mode: 'packet-up',
      alpn: 'http/1.1',
      fp: input.params.fingerprint,
    });
    return `vless://${input.uuid}@${input.params.domain}:${input.params.publicPort ?? 443}?${query.toString()}#${encodeURIComponent(input.name)}`;
  }
  const query = new URLSearchParams({
    type: 'tcp',
    security: 'reality',
    encryption: 'none',
    flow: input.params.flow,
    sni: input.params.sni!,
    fp: input.params.fingerprint,
    pbk: input.publicKey,
    sid: input.params.shortId!,
  });
  const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host;
  return `vless://${input.uuid}@${host}:${input.port}?${query.toString()}#${encodeURIComponent(input.name)}`;
}

// Вывод `xray api statsquery` — {"stat":[{"name":"user>>>EMAIL>>>traffic>>>uplink","value":"123"}]}
// (value может прийти строкой или числом, а нулевые значения Xray вообще опускает).
export function parseXrayUserStats(output: string): Map<string, { uplink: number; downlink: number }> {
  const result = new Map<string, { uplink: number; downlink: number }>();
  let parsed: { stat?: Array<{ name?: string; value?: string | number }> };
  try {
    parsed = JSON.parse(output);
  } catch {
    return result;
  }
  for (const stat of parsed.stat ?? []) {
    const match = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(stat.name ?? '');
    if (!match) {
      continue;
    }
    const entry = result.get(match[1]) ?? { uplink: 0, downlink: 0 };
    entry[match[2] as 'uplink' | 'downlink'] = Number(stat.value) || 0;
    result.set(match[1], entry);
  }
  return result;
}

// `xray x25519` печатает пары "Метка: значение" — первая строка всегда приватный ключ,
// вторая — публичный (в новых версиях Xray его метка сменилась с "Public key" на
// "Password", поэтому опираемся на порядок, а не на текст метки).
export function parseX25519Output(output: string): { privateKey: string; publicKey: string } {
  const values = output
    .split('\n')
    .map((line) => line.split(':').slice(1).join(':').trim())
    .filter((value) => /^[A-Za-z0-9_-]{40,}$/.test(value));
  if (values.length < 2) {
    throw new Error(`Не удалось разобрать вывод "xray x25519": ${output.trim()}`);
  }
  return { privateKey: values[0], publicKey: values[1] };
}
