import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { connectDashboardSocket, DashboardPeerStats, DashboardServerStats } from '../api/dashboard';

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

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Трафик активных peers
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Название</TableCell>
              <TableCell>Сервер</TableCell>
              <TableCell>Протокол</TableCell>
              <TableCell>↓ Скачивание</TableCell>
              <TableCell>↑ Отдача</TableCell>
              <TableCell>Всего получено / отправлено</TableCell>
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
              </TableRow>
            ))}
            {peers.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>{connected ? 'Нет активных peers' : 'Загрузка...'}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      {timestamp && (
        <Typography variant="caption" color="text.secondary">
          Обновлено: {new Date(timestamp).toLocaleTimeString()}
        </Typography>
      )}
    </Stack>
  );
}
