// Генерация всего, что нужно на self-сервере для обхода upstream моста по доменам
// (Bridge.bypassDestinations): DNS-сервер моста (dnsmasq), его systemd-юнит и скрипт
// загрузки IP в ipset. Чистые функции без SSH — исполняет VpnProvisioningService.

// ipset ограничивает длину имени 31 символом — префикс + 16 hex-символов id влезает.
export function bridgeShortId(bridgeId: string): string {
  return bridgeId.replace(/-/g, '').slice(0, 16);
}

export interface BridgeDnsNames {
  unitName: string;
  unitPath: string;
  confPath: string;
  pidPath: string;
  // Статический набор (домены, разрезолвленные панелью, + IP/CIDR из списка) — его
  // целиком перезаписывает периодический пересчёт (ipset swap).
  staticIpset: string;
  // Динамический набор — его пополняет dnsmasq в момент DNS-запроса клиента. Отдельно от
  // статического: swap статического стёр бы всё, что dnsmasq успел добавить.
  dynamicIpset: string;
}

export function bridgeDnsNames(bridgeId: string): BridgeDnsNames {
  const short = bridgeShortId(bridgeId);
  return {
    unitName: `vpnmanager-dns-${short}.service`,
    unitPath: `/etc/systemd/system/vpnmanager-dns-${short}.service`,
    confPath: `/etc/vpnmanager/dns-${short}.conf`,
    pidPath: `/run/vpnmanager-dns-${short}.pid`,
    staticIpset: `vpnmgr-byp-${short}`,
    dynamicIpset: `vpnmgr-bypd-${short}`,
  };
}

// Домены из списка обхода резолвим российским DNS напрямую с self-сервера — тот же
// адрес, по которому сайт отдаёт "российскую" версию. Всё остальное — через тоннель моста,
// как клиент и резолвил бы без нас (иначе ответы на заблокированные домены приходили бы
// подменённые российскими фильтрами).
export const DIRECT_DNS_RESOLVERS = ['77.88.8.8', '77.88.8.1'];
export const TUNNEL_DNS_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

// Время жизни IP в динамическом наборе — dnsmasq обновляет запись при каждом новом запросе
// клиента, так что для живых сервисов адрес не выпадает; устаревшие CDN-адреса уходят сами.
export const DYNAMIC_IPSET_TIMEOUT_SEC = 6 * 60 * 60;

export interface BridgeDnsConfigInput {
  // Шлюзовые адреса клиентских интерфейсов моста (без маски), например 10.9.0.1.
  listenAddresses: string[];
  domains: string[];
  dynamicIpset: string;
  upstreamInterface: string;
}

// Домен из списка покрывает и ВСЕ свои поддомены — это стандартная семантика server=/ и
// ipset=/ в dnsmasq, ради неё DNS-сервер моста и заводится (статический резолв панелью
// находит IP только точно указанного имени). Домены уже проверены classifyBypassEntry
// (только буквы/цифры/дефисы/точки), поэтому подставлять их в конфиг безопасно.
export function renderBridgeDnsConfig(input: BridgeDnsConfigInput): string {
  const lines = [
    '# Управляется VPN Manager (обход upstream моста по доменам) — не редактировать вручную.',
    'port=53',
    // bind-dynamic, а не bind-interfaces: клиентские интерфейсы моста при загрузке
    // поднимаются wg-quick/awg-quick, возможно позже самого dnsmasq.
    'bind-dynamic',
    ...input.listenAddresses.map((address) => `listen-address=${address}`),
    'no-resolv',
    'no-hosts',
    'cache-size=10000',
    ...TUNNEL_DNS_RESOLVERS.map((resolver) => `server=${resolver}@${input.upstreamInterface}`),
  ];
  for (const domain of input.domains) {
    for (const resolver of DIRECT_DNS_RESOLVERS) {
      lines.push(`server=/${domain}/${resolver}`);
    }
    lines.push(`ipset=/${domain}/${input.dynamicIpset}`);
  }
  return lines.join('\n') + '\n';
}

// root, а не обычный пользователь dnsmasq: добавлять в ipset нужно CAP_NET_ADMIN, а
// отправлять запросы через конкретный интерфейс тоннеля (server=...@iface) — привязку
// сокета к устройству.
export function renderBridgeDnsUnit(names: BridgeDnsNames): string {
  return [
    '[Unit]',
    'Description=VPN Manager - DNS моста (обход upstream по доменам)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --user=root --conf-file=${names.confPath} --pid-file=${names.pidPath}`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

// Скрипт для `ipset restore` — весь набор одной командой вместо отдельного SSH-вызова на
// каждый адрес (список на тысячи записей иначе применялся бы минутами). Атомарная замена
// содержимого через swap — без "окна", когда набор пуст.
export function renderIpsetRestoreScript(setName: string, entries: string[]): string {
  const tmpName = `${setName}-tmp`;
  const lines = [
    `create ${setName} hash:net -exist`,
    `create ${tmpName} hash:net -exist`,
    `flush ${tmpName}`,
    ...entries.map((entry) => `add ${tmpName} ${entry} -exist`),
    `swap ${tmpName} ${setName}`,
    `destroy ${tmpName}`,
  ];
  return lines.join('\n') + '\n';
}
