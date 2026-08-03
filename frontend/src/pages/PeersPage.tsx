import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
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
import { FormEvent, useEffect, useState } from 'react';
import { fetchBridges } from '../api/bridges';
import { getErrorMessage } from '../api/errors';
import { fetchOrganizations } from '../api/organizations';
import { CreatePeerInput, createPeer, downloadPeerConfig, fetchPeerQrCodeUrl, fetchPeers, purgePeer, revokePeer } from '../api/peers';
import { fetchServers } from '../api/servers';
import { BridgeEntity, PeerEntity, VpnProtocol } from '../api/types';
import { useAuth } from '../auth/AuthContext';

const statusColor: Record<string, 'success' | 'default'> = {
  active: 'success',
  revoked: 'default',
};

// Сентинел для «Клиент» в форме создания peer — отличает осознанный выбор «без клиента»
// (organizationId: null отправится на бэкенд) от ещё не подгруженного значения по
// умолчанию (пустая строка, см. useEffect ниже).
const NO_CLIENT = '__none__';
const DEFAULT_CLIENT_ORG_NAME = 'main';

// Peer моста ссылается на клиентский ServerProtocol моста, а не напрямую на мост —
// сверяем serverProtocolId со списком мостов, чтобы показать имя моста, а не имя
// (обычно скрытого от UI) self-сервера.
function serverLabel(peer: PeerEntity, bridges?: BridgeEntity[]): string {
  const bridge = bridges?.find(
    (b) => b.wireguardClientProtocolId === peer.serverProtocolId || b.amneziawgClientProtocolId === peer.serverProtocolId,
  );
  if (bridge) {
    return `Мост «${bridge.name}»`;
  }
  return peer.serverProtocol?.server?.name ?? '—';
}

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
  // Мосты доступны всем ролям (бэкенд сам скоупит по организации) — org_admin/org_user
  // должны иметь возможность создать peer для моста своей организации.
  const { data: bridges } = useQuery({ queryKey: ['bridges'], queryFn: fetchBridges });

  const { data: peers, isLoading } = useQuery({
    queryKey: ['peers', organizationFilter],
    queryFn: () => fetchPeers(organizationFilter || undefined),
  });

  const [form, setForm] = useState<CreatePeerInput>({ protocol: 'wireguard', name: '' });
  const [useBridge, setUseBridge] = useState(false);
  const [clientOrgId, setClientOrgId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [qrPeer, setQrPeer] = useState<PeerEntity | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  // По умолчанию — организация "main", если она есть; иначе явное «без клиента». Ставим
  // только один раз при первой загрузке списка организаций, не мешая последующему
  // осознанному выбору пользователя (в т.ч. выбору «Без клиента», который тоже непустой).
  useEffect(() => {
    if (isSuperAdmin && organizations && !clientOrgId) {
      const defaultOrg = organizations.find((org) => org.name === DEFAULT_CLIENT_ORG_NAME);
      setClientOrgId(defaultOrg ? defaultOrg.id : NO_CLIENT);
    }
  }, [isSuperAdmin, organizations, clientOrgId]);

  const createMutation = useMutation({
    mutationFn: createPeer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['peers'] });
      setForm({ protocol: 'wireguard', name: '' });
      setUseBridge(false);
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось создать peer')),
  });

  const revokeMutation = useMutation({
    mutationFn: revokePeer,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['peers'] }),
  });

  const purgeMutation = useMutation({
    mutationFn: purgePeer,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['peers'] }),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate({
      ...form,
      organizationId: isSuperAdmin ? (clientOrgId === NO_CLIENT ? null : clientOrgId) : undefined,
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
            {bridges && bridges.length > 0 && (
              <FormControlLabel
                sx={{ mt: 1 }}
                control={
                  <Checkbox
                    checked={useBridge}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUseBridge(checked);
                      if (!checked) {
                        setForm({ ...form, bridgeId: undefined });
                        return;
                      }
                      // Если мост ровно один — сразу подставляем его, иначе оставляем
                      // выбор пользователю (см. поле «Мост» ниже).
                      const bridgeId = bridges.length === 1 ? bridges[0].id : undefined;
                      const selected = bridges.find((b) => b.id === bridgeId);
                      const availableProtocols: VpnProtocol[] = selected
                        ? ([selected.wireguardClientProtocolId && 'wireguard', selected.amneziawgClientProtocolId && 'amneziawg'].filter(
                            Boolean,
                          ) as VpnProtocol[])
                        : [];
                      const protocol = availableProtocols.includes(form.protocol) ? form.protocol : availableProtocols[0] ?? form.protocol;
                      setForm({ ...form, bridgeId, serverId: undefined, protocol });
                    }}
                  />
                }
                label="Мост"
              />
            )}
            {useBridge && (
              <TextField
                select
                label="Какой мост"
                value={form.bridgeId || ''}
                onChange={(e) => {
                  const bridgeId = e.target.value || undefined;
                  const selected = bridges?.find((b) => b.id === bridgeId);
                  // Мост может выдавать peers по одному или обоим протоколам сразу —
                  // подставляем тот, что реально доступен, чтобы не наткнуться на ошибку
                  // "протокол не установлен".
                  const availableProtocols: VpnProtocol[] = selected
                    ? ([selected.wireguardClientProtocolId && 'wireguard', selected.amneziawgClientProtocolId && 'amneziawg'].filter(
                        Boolean,
                      ) as VpnProtocol[])
                    : [];
                  const protocol = availableProtocols.includes(form.protocol) ? form.protocol : availableProtocols[0] ?? form.protocol;
                  setForm({ ...form, bridgeId, protocol });
                }}
                sx={{ minWidth: 200 }}
                helperText="Peer станет клиентом этого моста — создастся на менеджере"
                required
              >
                {bridges?.map((b) => (
                  <MenuItem key={b.id} value={b.id}>
                    {b.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {isSuperAdmin && !useBridge && (
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
                helperText="Обычный сервер — не мост"
              >
                <MenuItem value="">Автоматически (балансировка)</MenuItem>
                {servers
                  ?.filter((s) => !s.isSelf)
                  .map((s) => (
                    <MenuItem key={s.id} value={s.id}>
                      {s.name}
                    </MenuItem>
                  ))}
              </TextField>
            )}
            {isSuperAdmin && (
              <TextField
                select
                label="Клиент"
                value={clientOrgId}
                onChange={(e) => setClientOrgId(e.target.value)}
                sx={{ minWidth: 200 }}
                helperText="Организация, для которой создаётся peer"
              >
                <MenuItem value={NO_CLIENT}>Без клиента</MenuItem>
                {organizations?.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <Button type="submit" variant="contained" disabled={createMutation.isPending || (isSuperAdmin && !clientOrgId)}>
              Создать
            </Button>
          </Stack>
        </form>
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
              <TableCell>Сервер</TableCell>
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
                <TableCell>{serverLabel(peer, bridges)}</TableCell>
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
                  {peer.status === 'revoked' && (
                    <Button size="small" color="error" onClick={() => purgeMutation.mutate(peer.id)}>
                      Удалить
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && peers?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>Peers пока нет</TableCell>
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
