import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { fetchOrganizations } from '../api/organizations';
import { CreatePeerInput, createPeer, downloadPeerConfig, fetchPeerQrCodeUrl, fetchPeers, revokePeer } from '../api/peers';
import { fetchServers } from '../api/servers';
import { PeerEntity, VpnProtocol } from '../api/types';
import { useAuth } from '../auth/AuthContext';

const statusColor: Record<string, 'success' | 'default'> = {
  active: 'success',
  revoked: 'default',
};

export function PeersPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const queryClient = useQueryClient();

  const [organizationFilter, setOrganizationFilter] = useState('');
  const { data: organizations } = useQuery({
    queryKey: ['organizations'],
    queryFn: fetchOrganizations,
    enabled: isSuperAdmin,
  });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: fetchServers, enabled: isSuperAdmin });

  const { data: peers, isLoading } = useQuery({
    queryKey: ['peers', organizationFilter],
    queryFn: () => fetchPeers(organizationFilter || undefined),
  });

  const [form, setForm] = useState<CreatePeerInput>({ protocol: 'wireguard', name: '' });
  const [error, setError] = useState<string | null>(null);
  const [qrPeer, setQrPeer] = useState<PeerEntity | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createPeer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['peers'] });
      setForm({ protocol: 'wireguard', name: '' });
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось создать peer')),
  });

  const revokeMutation = useMutation({
    mutationFn: revokePeer,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['peers'] }),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate({
      ...form,
      organizationId: isSuperAdmin ? organizationFilter || undefined : undefined,
    });
  }

  async function handleShowQr(peer: PeerEntity) {
    const url = await fetchPeerQrCodeUrl(peer.id);
    setQrPeer(peer);
    setQrUrl(url);
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Peers (учётные записи VPN)</Typography>

      {isSuperAdmin && (
        <TextField
          select
          label="Организация"
          value={organizationFilter}
          onChange={(e) => setOrganizationFilter(e.target.value)}
          sx={{ maxWidth: 300 }}
        >
          <MenuItem value="">Все организации</MenuItem>
          {organizations?.map((org) => (
            <MenuItem key={org.id} value={org.id}>
              {org.name}
            </MenuItem>
          ))}
        </TextField>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Новый peer
        </Typography>
        <form onSubmit={handleSubmit}>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
            <TextField label="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <TextField
              select
              label="Протокол"
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value as VpnProtocol })}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="wireguard">WireGuard</MenuItem>
              <MenuItem value="amneziawg">AmneziaWG</MenuItem>
            </TextField>
            {isSuperAdmin && (
              <TextField
                select
                label="Сервер (авто, если не выбран)"
                value={form.serverId || ''}
                onChange={(e) => {
                  const serverId = e.target.value || undefined;
                  const selected = servers?.find((s) => s.id === serverId);
                  // У self-сервера обычно только один установленный протокол (тот, что
                  // выбрали при создании моста — WireGuard или AmneziaWG). Подставляем его
                  // автоматически, иначе комбинация протокол+сервер может не найтись.
                  const activeProtocol = selected?.protocols.find((p) => p.status === 'active')?.protocol;
                  setForm({ ...form, serverId, protocol: activeProtocol ?? form.protocol });
                }}
                sx={{ minWidth: 240 }}
                helperText="Сервер с пометкой «Мост» — это self-сервер, peer будет клиентом моста"
              >
                <MenuItem value="">Автоматически (балансировка)</MenuItem>
                {servers?.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.isSelf ? `Мост: ${s.name}` : s.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              Создать
            </Button>
          </Stack>
        </form>
        {isSuperAdmin && !organizationFilter && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Выберите организацию выше, чтобы создать peer для конкретного клиента.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Название</TableCell>
              <TableCell>Протокол/IP</TableCell>
              <TableCell>Источник</TableCell>
              <TableCell>Статус</TableCell>
              <TableCell align="right">Действия</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {peers?.map((peer) => (
              <TableRow key={peer.id}>
                <TableCell>{peer.name}</TableCell>
                <TableCell>{peer.allowedIp}</TableCell>
                <TableCell>{peer.source === 'created' ? 'создан в сервисе' : 'импортирован'}</TableCell>
                <TableCell>
                  <Chip size="small" label={peer.status} color={statusColor[peer.status]} />
                </TableCell>
                <TableCell align="right">
                  <Button
                    size="small"
                    disabled={peer.source === 'imported'}
                    onClick={() => downloadPeerConfig(peer.id, peer.name)}
                  >
                    Скачать
                  </Button>
                  <Button size="small" disabled={peer.source === 'imported'} onClick={() => handleShowQr(peer)}>
                    QR
                  </Button>
                  {peer.status === 'active' && (
                    <Button size="small" color="error" onClick={() => revokeMutation.mutate(peer.id)}>
                      Отозвать
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && peers?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>Peers пока нет</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={!!qrPeer} onClose={() => setQrPeer(null)}>
        <DialogTitle>QR-код: {qrPeer?.name}</DialogTitle>
        <DialogContent>{qrUrl && <img src={qrUrl} alt="QR-код конфигурации" width={320} height={320} />}</DialogContent>
      </Dialog>
    </Stack>
  );
}
