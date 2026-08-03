import {
  Alert,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
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

const protocolLabels: Record<string, string> = { wireguard: 'WireGuard', amneziawg: 'AmneziaWG' };

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
        <Typography variant="subtitle1" mb={2}>
          Серверы
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Сервер</TableCell>
              <TableCell>Статус</TableCell>
              <TableCell>Load average (1 мин)</TableCell>
              <TableCell>Память</TableCell>
              <TableCell>Peers</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {servers.map((server) => (
              <TableRow key={server.serverId}>
                <TableCell>
                  {server.serverName}
                  {server.isSelf && <Chip size="small" label="менеджер" color="info" sx={{ ml: 1 }} />}
                </TableCell>
                <TableCell>
                  <Chip size="small" label={server.online ? 'online' : 'offline'} color={server.online ? 'success' : 'error'} />
                </TableCell>
                <TableCell>{server.loadAvg1 ?? '—'}</TableCell>
                <TableCell>
                  {server.memUsedMb !== null && server.memTotalMb !== null
                    ? `${server.memUsedMb} / ${server.memTotalMb} МБ`
                    : '—'}
                </TableCell>
                <TableCell sx={{ minWidth: 160 }}>
                  <Stack spacing={0.5}>
                    <Typography variant="body2">
                      {server.activePeers} / {server.maxPeers}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={server.maxPeers > 0 ? Math.min(100, (server.activePeers / server.maxPeers) * 100) : 0}
                    />
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
            {servers.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>{connected ? 'Нет добавленных серверов' : 'Загрузка...'}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
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
