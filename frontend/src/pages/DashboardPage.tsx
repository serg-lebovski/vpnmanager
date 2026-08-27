import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { fetchOrganizations } from '../api/organizations';
import { fetchServers } from '../api/servers';
import {
  connectDashboardSocket,
  DashboardPeerStats,
  DashboardServerStats,
  fetchTrafficByOrganization,
  fetchTrafficByPeer,
  fetchTrafficByServer,
  fetchTrafficMonthly,
  TrafficRange,
} from '../api/dashboard';

function formatBytesPerSecond(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond} Б/с`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} КБ/с`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} МБ/с`;
}

function formatBytesTotal(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`;
  return `${Math.round(mb)} МБ`;
}

// PersistentKeepalive у клиентских конфигов = 25с — активное устройство рукопожатится
// заметно чаще этого порога, поэтому "недавно" (последние 3 минуты) читаем как "сейчас
// подключён", а не просто "было соединение когда-то".
const ONLINE_THRESHOLD_SECONDS = 3 * 60;

function formatLastHandshake(latestHandshake: number): string {
  if (!latestHandshake) return 'Никогда';
  const secondsAgo = Date.now() / 1000 - latestHandshake;
  if (secondsAgo < ONLINE_THRESHOLD_SECONDS) return 'Сейчас в сети';
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)} мин назад`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)} ч назад`;
  return new Date(latestHandshake * 1000).toLocaleString();
}

function isRecentlyOnline(latestHandshake: number): boolean {
  return latestHandshake > 0 && Date.now() / 1000 - latestHandshake < ONLINE_THRESHOLD_SECONDS;
}

function formatEndpointIp(endpoint: string | null): string {
  if (!endpoint) return '—';
  // "ip:port" или "[ipv6]:port" — отсекаем порт, панели интересен только адрес клиента.
  const ipv6Match = endpoint.match(/^\[(.+)\]:\d+$/);
  if (ipv6Match) return ipv6Match[1];
  const lastColon = endpoint.lastIndexOf(':');
  return lastColon > 0 ? endpoint.slice(0, lastColon) : endpoint;
}

// Условный опорный уровень для индикатора "Сеть" — у SSH-опроса нет способа узнать
// реальную пропускную способность канала конкретного VPS, поэтому 100% здесь — это
// не "канал забит", а "трафик достиг этого условного ориентира" (100 Мбит/с), просто
// чтобы кружок был из чего заполнять. Точные цифры всегда видны в подсказке при наведении.
const NETWORK_REFERENCE_BPS = (100 * 1024 * 1024) / 8;

const protocolLabels: Record<string, string> = { wireguard: 'WireGuard', amneziawg: 'AmneziaWG' };

function gaugeColor(percent: number | null): 'success' | 'warning' | 'error' | 'inherit' {
  if (percent === null) return 'inherit';
  if (percent >= 90) return 'error';
  if (percent >= 70) return 'warning';
  return 'success';
}

function CircularStat({ label, percent, tooltip }: { label: string; percent: number | null; tooltip: string }) {
  const color = gaugeColor(percent);
  return (
    <Tooltip title={tooltip} arrow>
      <Stack alignItems="center" spacing={0.5} sx={{ minWidth: 60 }}>
        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
          <CircularProgress
            variant="determinate"
            value={percent ?? 0}
            size={48}
            thickness={5}
            {...(color !== 'inherit' ? { color } : {})}
            sx={color === 'inherit' ? { color: 'action.disabled' } : undefined}
          />
          <Box
            sx={{
              top: 0,
              left: 0,
              bottom: 0,
              right: 0,
              position: 'absolute',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography variant="caption" component="div" color="text.secondary">
              {percent === null ? '—' : `${Math.round(percent)}%`}
            </Typography>
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

function ServerLoadRow({ server }: { server: DashboardServerStats }) {
  // % CPU без отдельных /proc/stat замеров с интервалом точно не посчитать — loadavg
  // (за 1 мин) делённый на число ядер — принятое приближение, не точная мгновенная загрузка.
  const cpuPercent = server.loadAvg1 !== null && server.cpuCores ? Math.min(100, (server.loadAvg1 / server.cpuCores) * 100) : null;
  const memPercent = server.memUsedMb !== null && server.memTotalMb ? Math.min(100, (server.memUsedMb / server.memTotalMb) * 100) : null;
  const diskPercent =
    server.diskUsedMb !== null && server.diskTotalMb ? Math.min(100, (server.diskUsedMb / server.diskTotalMb) * 100) : null;
  const networkPercent = server.online ? Math.min(100, (server.networkBps / NETWORK_REFERENCE_BPS) * 100) : null;

  return (
    <Stack direction="row" alignItems="center" spacing={3} sx={{ py: 1.5, flexWrap: 'wrap', rowGap: 1.5 }}>
      <Box sx={{ minWidth: 200 }}>
        <Typography variant="body1">
          {server.serverName}
          {server.isSelf && <Chip size="small" label="менеджер" color="info" sx={{ ml: 1 }} />}
        </Typography>
        <Chip size="small" label={server.online ? 'online' : 'offline'} color={server.online ? 'success' : 'error'} />
      </Box>

      <Stack direction="row" spacing={2}>
        <CircularStat
          label="CPU"
          percent={cpuPercent}
          tooltip={
            server.loadAvg1 !== null && server.cpuCores
              ? `Load average (1 мин): ${server.loadAvg1} на ${server.cpuCores} ядер`
              : 'Нет данных'
          }
        />
        <CircularStat
          label="RAM"
          percent={memPercent}
          tooltip={
            server.memUsedMb !== null && server.memTotalMb
              ? `${formatMb(server.memUsedMb)} занято из ${formatMb(server.memTotalMb)}`
              : 'Нет данных'
          }
        />
        <CircularStat
          label="Диск"
          percent={diskPercent}
          tooltip={
            server.diskUsedMb !== null && server.diskTotalMb
              ? `${formatMb(server.diskUsedMb)} занято из ${formatMb(server.diskTotalMb)}`
              : 'Нет данных'
          }
        />
        <CircularStat
          label="Сеть"
          percent={networkPercent}
          tooltip={
            server.online
              ? `${formatBytesPerSecond(server.networkBps)} сейчас (условный ориентир — 100 Мбит/с)`
              : 'Нет данных'
          }
        />
      </Stack>

      <Box sx={{ ml: 'auto', minWidth: 140 }}>
        <Typography variant="body2">
          {server.activePeers} / {server.maxPeers} peers
        </Typography>
        <LinearProgress
          variant="determinate"
          value={server.maxPeers > 0 ? Math.min(100, (server.activePeers / server.maxPeers) * 100) : 0}
        />
      </Box>
    </Stack>
  );
}

// Сводка "какой протокол на каком сервере используется" — считается на лету из живого
// снапшота (DashboardPeerStats уже несёт serverName+protocol на каждый активный peer),
// без отдельного запроса к бэкенду.
interface ServerProtocolBreakdown {
  serverName: string;
  wireguard: number;
  amneziawg: number;
}

function ProtocolsByServerSection({ peers }: { peers: DashboardPeerStats[] }) {
  const rows = useMemo<ServerProtocolBreakdown[]>(() => {
    const byServer = new Map<string, ServerProtocolBreakdown>();
    for (const peer of peers) {
      const entry = byServer.get(peer.serverName) ?? { serverName: peer.serverName, wireguard: 0, amneziawg: 0 };
      if (peer.protocol === 'wireguard') {
        entry.wireguard += 1;
      } else if (peer.protocol === 'amneziawg') {
        entry.amneziawg += 1;
      }
      byServer.set(peer.serverName, entry);
    }
    return Array.from(byServer.values()).sort((a, b) => a.serverName.localeCompare(b.serverName));
  }, [peers]);

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="subtitle1" mb={1}>
        Протоколы по серверам
      </Typography>
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Сервер</TableCell>
              <TableCell>WireGuard</TableCell>
              <TableCell>AmneziaWG</TableCell>
              <TableCell>Всего активных peers</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.serverName}>
                <TableCell>{row.serverName}</TableCell>
                <TableCell>{row.wireguard}</TableCell>
                <TableCell>{row.amneziawg}</TableCell>
                <TableCell>{row.wireguard + row.amneziawg}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>Нет активных peers</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

const rangeLabels: Record<TrafficRange, string> = { day: 'День', week: 'Неделя', month: 'Месяц' };

const ALL_FILTER_VALUE = '__all__';

// История трафика — в отличие от остальной страницы (живой снапшот по WebSocket), это
// обычные REST-запросы с историческими агрегатами (см. DashboardService.getTrafficByServer/
// getTrafficByOrganization/getTrafficByPeer/getTrafficMonthly на бэкенде) — react-query, без
// сокета. Фильтры по клиенту/серверу — для удобства мониторинга, применяются ко всем
// разрезам сразу (кроме "по клиентам", который сам по себе и есть разрез по клиенту, туда
// applies только фильтр по серверу — "кто из клиентов сколько ест именно на этом сервере").
function TrafficSection() {
  const [range, setRange] = useState<TrafficRange>('day');
  const [organizationId, setOrganizationId] = useState<string>(ALL_FILTER_VALUE);
  const [serverId, setServerId] = useState<string>(ALL_FILTER_VALUE);

  const { data: organizations } = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: fetchServers });

  const orgFilter = organizationId === ALL_FILTER_VALUE ? undefined : organizationId;
  const serverFilter = serverId === ALL_FILTER_VALUE ? undefined : serverId;
  const filters = { organizationId: orgFilter, serverId: serverFilter };

  const { data: byOrganization, isLoading: loadingByOrganization } = useQuery({
    queryKey: ['traffic-by-organization', range, serverFilter],
    queryFn: () => fetchTrafficByOrganization(range, filters),
  });
  const { data: byServer, isLoading: loadingByServer } = useQuery({
    queryKey: ['traffic-by-server', range, orgFilter],
    queryFn: () => fetchTrafficByServer(range, filters),
  });
  const { data: byPeer, isLoading: loadingByPeer } = useQuery({
    queryKey: ['traffic-by-peer', range, orgFilter, serverFilter],
    queryFn: () => fetchTrafficByPeer(range, filters),
  });
  const { data: monthly, isLoading: loadingMonthly } = useQuery({
    queryKey: ['traffic-monthly', orgFilter],
    queryFn: () => fetchTrafficMonthly(6, filters),
  });

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2} flexWrap="wrap" rowGap={1}>
        <Typography variant="subtitle1">История трафика</Typography>
        <Stack direction="row" spacing={1}>
          {(['day', 'week', 'month'] as TrafficRange[]).map((r) => (
            <Chip
              key={r}
              size="small"
              label={rangeLabels[r]}
              color={range === r ? 'primary' : 'default'}
              onClick={() => setRange(r)}
            />
          ))}
        </Stack>
      </Stack>

      <Stack direction="row" spacing={2} mb={3} flexWrap="wrap" rowGap={1}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Клиент</InputLabel>
          <Select label="Клиент" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
            <MenuItem value={ALL_FILTER_VALUE}>Все клиенты</MenuItem>
            {organizations?.map((org) => (
              <MenuItem key={org.id} value={org.id}>
                {org.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Сервер</InputLabel>
          <Select label="Сервер" value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <MenuItem value={ALL_FILTER_VALUE}>Все серверы</MenuItem>
            {servers?.map((server) => (
              <MenuItem key={server.id} value={server.id}>
                {server.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <Typography variant="body2" color="text.secondary" mb={1}>
        По клиентам{serverFilter ? ' (на выбранном сервере)' : ''} — за период «{rangeLabels[range]}»
      </Typography>
      <TableContainer sx={{ overflowX: 'auto', mb: 3 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Клиент</TableCell>
            <TableCell>Скачано</TableCell>
            <TableCell>Отправлено</TableCell>
            <TableCell>Итого</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {byOrganization?.map((row) => (
            <TableRow key={row.organizationId ?? 'none'}>
              <TableCell>{row.organizationName}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.txBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes + row.txBytes)}</TableCell>
            </TableRow>
          ))}
          {!loadingByOrganization && (byOrganization?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={4}>Нет данных за этот период</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </TableContainer>

      <Typography variant="body2" color="text.secondary" mb={1}>
        По серверам (включая self-серверы, несущие мосты){orgFilter ? ' — только выбранный клиент' : ''} — за период
        «{rangeLabels[range]}»
      </Typography>
      <TableContainer sx={{ overflowX: 'auto', mb: 3 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Сервер</TableCell>
            <TableCell>Скачано</TableCell>
            <TableCell>Отправлено</TableCell>
            <TableCell>Итого</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {byServer?.map((row) => (
            <TableRow key={row.serverId}>
              <TableCell>{row.serverName}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.txBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes + row.txBytes)}</TableCell>
            </TableRow>
          ))}
          {!loadingByServer && (byServer?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={4}>Нет данных за этот период</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </TableContainer>

      <Typography variant="body2" color="text.secondary" mb={1}>
        По peers — за период «{rangeLabels[range]}»
      </Typography>
      <TableContainer sx={{ overflowX: 'auto', mb: 3 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Peer</TableCell>
            <TableCell>Клиент</TableCell>
            <TableCell>Сервер</TableCell>
            <TableCell>Скачано</TableCell>
            <TableCell>Отправлено</TableCell>
            <TableCell>Итого</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {byPeer?.map((row) => (
            <TableRow key={row.peerId}>
              <TableCell>{row.peerName}</TableCell>
              <TableCell>{row.organizationName}</TableCell>
              <TableCell>{row.serverName}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.txBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes + row.txBytes)}</TableCell>
            </TableRow>
          ))}
          {!loadingByPeer && (byPeer?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={6}>Нет данных за этот период</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </TableContainer>

      <Typography variant="body2" color="text.secondary" mb={1}>
        Помесячно (последние 6 месяцев), по серверам{orgFilter ? ' — только выбранный клиент' : ''}
      </Typography>
      <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Месяц</TableCell>
            <TableCell>Сервер</TableCell>
            <TableCell>Скачано</TableCell>
            <TableCell>Отправлено</TableCell>
            <TableCell>Итого</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {monthly?.map((row) => (
            <TableRow key={`${row.month}-${row.serverId}`}>
              <TableCell>{row.month}</TableCell>
              <TableCell>{row.serverName}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.txBytes)}</TableCell>
              <TableCell>{formatBytesTotal(row.rxBytes + row.txBytes)}</TableCell>
            </TableRow>
          ))}
          {!loadingMonthly && (monthly?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={5}>Нет данных — история накапливается по мере работы панели</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </TableContainer>
    </Paper>
  );
}

export function DashboardPage() {
  const [servers, setServers] = useState<DashboardServerStats[]>([]);
  const [peers, setPeers] = useState<DashboardPeerStats[]>([]);
  const [connected, setConnected] = useState(false);
  const [timestamp, setTimestamp] = useState<string | null>(null);

  useEffect(() => {
    const socket = connectDashboardSocket((snapshot) => {
      setServers(snapshot.servers);
      setPeers(snapshot.peers);
      setTimestamp(snapshot.timestamp);
    });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <Stack spacing={3}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Дашборд</Typography>
        <Chip
          size="small"
          label={connected ? 'Обновляется в реальном времени' : 'Нет соединения'}
          color={connected ? 'success' : 'default'}
        />
      </Stack>
      {!connected && (
        <Alert severity="info">
          Устанавливаем соединение для обновлений в реальном времени... Если сообщение не исчезает — проверьте, что
          вы вошли под суперадмином и nginx настроен на проксирование `/socket.io/` (см. README).
        </Alert>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={1}>
          Серверы
        </Typography>
        <Stack divider={<Divider />}>
          {servers.map((server) => (
            <ServerLoadRow key={server.serverId} server={server} />
          ))}
          {servers.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              {connected ? 'Нет добавленных серверов' : 'Загрузка...'}
            </Typography>
          )}
        </Stack>
      </Paper>

      <ProtocolsByServerSection peers={peers} />

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Трафик активных peers
        </Typography>
        <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Название</TableCell>
              <TableCell>Сервер</TableCell>
              <TableCell>Протокол</TableCell>
              <TableCell>↓ Скачивание</TableCell>
              <TableCell>↑ Отдача</TableCell>
              <TableCell>Всего получено / отправлено</TableCell>
              <TableCell>Последнее рукопожатие</TableCell>
              <TableCell>IP-адрес клиента</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {peers.map((peer) => (
              <TableRow key={peer.peerId}>
                <TableCell>{peer.name}</TableCell>
                <TableCell>{peer.serverName}</TableCell>
                <TableCell>{protocolLabels[peer.protocol] ?? peer.protocol}</TableCell>
                <TableCell>{formatBytesPerSecond(peer.rxBps)}</TableCell>
                <TableCell>{formatBytesPerSecond(peer.txBps)}</TableCell>
                <TableCell>
                  {formatBytesTotal(peer.rxBytesTotal)} / {formatBytesTotal(peer.txBytesTotal)}
                </TableCell>
                <TableCell>
                  <Typography
                    variant="body2"
                    color={isRecentlyOnline(peer.latestHandshake) ? 'success.main' : 'text.secondary'}
                    fontWeight={isRecentlyOnline(peer.latestHandshake) ? 600 : 400}
                  >
                    {formatLastHandshake(peer.latestHandshake)}
                  </Typography>
                </TableCell>
                <TableCell>{formatEndpointIp(peer.endpoint)}</TableCell>
              </TableRow>
            ))}
            {peers.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>{connected ? 'Нет активных peers' : 'Загрузка...'}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </TableContainer>
      </Paper>

      {timestamp && (
        <Typography variant="caption" color="text.secondary">
          Обновлено: {new Date(timestamp).toLocaleTimeString()}
        </Typography>
      )}

      <TrafficSection />
    </Stack>
  );
}
