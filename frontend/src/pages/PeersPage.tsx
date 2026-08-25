import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import BlockIcon from '@mui/icons-material/Block';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import PhonelinkRingIcon from '@mui/icons-material/PhonelinkRing';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { fetchBridges } from '../api/bridges';
import { getErrorMessage } from '../api/errors';
import { fetchOrganizations } from '../api/organizations';
import {
  CreatePeerInput,
  createPeer,
  downloadPeerAmneziaConfig,
  downloadPeerConfig,
  fetchAllowedServers,
  fetchPeerQrCodeUrl,
  fetchPeers,
  purgePeer,
  revokePeer,
  updatePeer,
} from '../api/peers';
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
  // ENGINEER создаёт peers для ЛЮБОЙ организации/моста/сервера, как суперадмин (см.
  // PeersService на бэкенде) — но не привязан к организации, и в отличие от суперадмина не
  // видит чужие peers (список/фильтр по организации, редактирование срока действия — ниже
  // остаются isSuperAdmin-only).
  const isEngineer = user?.role === 'engineer';
  const canManageAnyOrg = isSuperAdmin || isEngineer;
  const queryClient = useQueryClient();

  const [organizationFilter, setOrganizationFilter] = useState('');
  const { data: organizations } = useQuery({
    queryKey: ['organizations'],
    queryFn: fetchOrganizations,
    enabled: canManageAnyOrg,
  });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: fetchServers, enabled: canManageAnyOrg });
  // Мосты доступны всем ролям (бэкенд сам скоупит по организации, включая
  // Organization.blockedBridgeIds) — org_admin/org_user должны иметь возможность создать
  // peer для моста своей организации.
  const { data: bridges } = useQuery({ queryKey: ['bridges'], queryFn: fetchBridges });
  // Обычные серверы, доступные НАПРЯМУЮ (в обход моста) — для super_admin/engineer
  // используется полный /servers (там же protocols для авто-подстановки протокола), для
  // остальных — Organization.allowedServerIds (см. fetchAllowedServers).
  const { data: allowedServers } = useQuery({
    queryKey: ['peers-allowed-servers'],
    queryFn: fetchAllowedServers,
    enabled: !canManageAnyOrg,
  });
  const { data: peers, isLoading } = useQuery({
    queryKey: ['peers', organizationFilter],
    queryFn: () => fetchPeers(organizationFilter || undefined),
  });

  const [form, setForm] = useState<CreatePeerInput>({ protocol: 'wireguard', name: '' });
  const [clientOrgId, setClientOrgId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [qrPeer, setQrPeer] = useState<PeerEntity | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  // Если мост доступен и пользователь не выбрал сервер явно — создаём через мост по
  // умолчанию (это и есть весь смысл моста — обычные серверы прямым выбором не должны
  // требоваться). Срабатывает один раз при загрузке списка мостов и повторно после
  // каждого успешного создания peer (см. createMutation.onSuccess) — не трогает форму,
  // если пользователь уже выбрал мост или сервер сам.
  function applyDefaultBridgeSelection(base: CreatePeerInput): CreatePeerInput {
    if (base.bridgeId || base.serverId || !bridges || bridges.length === 0) {
      return base;
    }
    const bridge = bridges[0];
    const availableProtocols: VpnProtocol[] = [
      bridge.wireguardClientProtocolId && 'wireguard',
      bridge.amneziawgClientProtocolId && 'amneziawg',
    ].filter(Boolean) as VpnProtocol[];
    return { ...base, bridgeId: bridge.id, protocol: availableProtocols[0] ?? base.protocol };
  }

  useEffect(() => {
    setForm((prev) => applyDefaultBridgeSelection(prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridges]);

  // По умолчанию — организация "main", если она есть; иначе явное «без клиента». Ставим
  // только один раз при первой загрузке списка организаций, не мешая последующему
  // осознанному выбору пользователя (в т.ч. выбору «Без клиента», который тоже непустой).
  useEffect(() => {
    if (canManageAnyOrg && organizations && !clientOrgId) {
      const defaultOrg = organizations.find((org) => org.name === DEFAULT_CLIENT_ORG_NAME);
      setClientOrgId(defaultOrg ? defaultOrg.id : NO_CLIENT);
    }
  }, [canManageAnyOrg, organizations, clientOrgId]);

  const createMutation = useMutation({
    mutationFn: createPeer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['peers'] });
      setForm(applyDefaultBridgeSelection({ protocol: 'wireguard', name: '' }));
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

  const [editingPeer, setEditingPeer] = useState<PeerEntity | null>(null);
  const [editName, setEditName] = useState('');
  const [editOrgId, setEditOrgId] = useState('');
  // Дата в формате input[type=date] (YYYY-MM-DD) — интерпретируется как «действует
  // включительно по конец этого дня» (см. updateMutation ниже).
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [editUnlimited, setEditUnlimited] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: () =>
      updatePeer(editingPeer!.id, {
        name: editName,
        organizationId: isSuperAdmin ? (editOrgId === NO_CLIENT ? null : editOrgId) : undefined,
        expiresAt: isSuperAdmin
          ? editUnlimited
            ? null
            : new Date(`${editExpiresAt}T23:59:59`).toISOString()
          : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['peers'] });
      setEditingPeer(null);
    },
    onError: (err) => setEditError(getErrorMessage(err, 'Не удалось сохранить изменения')),
  });

  function openEdit(peer: PeerEntity) {
    setEditingPeer(peer);
    setEditName(peer.name);
    setEditOrgId(peer.organizationId ?? NO_CLIENT);
    setEditExpiresAt(peer.expiresAt ? peer.expiresAt.slice(0, 10) : '');
    setEditUnlimited(!peer.expiresAt);
    setEditError(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate({
      ...form,
      organizationId: canManageAnyOrg ? (clientOrgId === NO_CLIENT ? null : clientOrgId) : undefined,
    });
  }

  async function handleShowQr(peer: PeerEntity) {
    const url = await fetchPeerQrCodeUrl(peer.id);
    setQrPeer(peer);
    setQrUrl(url);
  }

  type SortKey = 'name' | 'server' | 'status';
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const visiblePeers = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (peers ?? []).filter((peer) => {
      if (!query) return true;
      const server = serverLabel(peer, bridges);
      return (
        peer.name.toLowerCase().includes(query) ||
        peer.allowedIp.toLowerCase().includes(query) ||
        server.toLowerCase().includes(query)
      );
    });
    const sorted = [...filtered].sort((a, b) => {
      const valueOf = (peer: PeerEntity) =>
        sortKey === 'name' ? peer.name : sortKey === 'server' ? serverLabel(peer, bridges) : peer.status;
      return valueOf(a).localeCompare(valueOf(b));
    });
    return sortDir === 'asc' ? sorted : sorted.reverse();
  }, [peers, bridges, search, sortKey, sortDir]);

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

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="flex-start">
        <Paper sx={{ p: 2, width: { xs: '100%', md: 320 }, flexShrink: 0 }}>
          <Typography variant="subtitle1" mb={2}>
            Новый peer
          </Typography>
          <form onSubmit={handleSubmit}>
            <Stack spacing={1.5}>
              <TextField
                label="Название"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                size="small"
                fullWidth
                required
              />
              <TextField
                select
                label="Протокол"
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value as VpnProtocol })}
                size="small"
                fullWidth
                disabled={form.multiProtocol}
              >
                <MenuItem value="wireguard">WireGuard</MenuItem>
                <MenuItem value="amneziawg">AmneziaWG</MenuItem>
              </TextField>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={!!form.multiProtocol}
                    onChange={(e) => setForm({ ...form, multiProtocol: e.target.checked })}
                  />
                }
                label="Мультиконфиг (WireGuard + AmneziaWG)"
              />
              {form.multiProtocol && (
                <Alert severity="info" sx={{ fontSize: '0.8rem' }}>
                  Создаст сразу два peer'а на выбранном мосту/сервере и выдаст один .vpn-файл для
                  приложения AmneziaVPN — протокол переключается прямо внутри приложения. Требует, чтобы
                  на мосту/сервере были активны ОБА протокола.
                </Alert>
              )}
              {bridges && bridges.length > 0 && (
                <TextField
                  select
                  label="Мост"
                  value={form.bridgeId || ''}
                  onChange={(e) => {
                    const bridgeId = e.target.value || undefined;
                    if (!bridgeId) {
                      // Явный отказ от моста — выбор конкретного сервера ниже (если доступен).
                      setForm({ ...form, bridgeId: undefined });
                      return;
                    }
                    const selected = bridges.find((b) => b.id === bridgeId);
                    // Мост может выдавать peers по одному или обоим протоколам сразу —
                    // подставляем тот, что реально доступен, чтобы не наткнуться на ошибку
                    // "протокол не установлен".
                    const availableProtocols: VpnProtocol[] = selected
                      ? ([selected.wireguardClientProtocolId && 'wireguard', selected.amneziawgClientProtocolId && 'amneziawg'].filter(
                          Boolean,
                        ) as VpnProtocol[])
                      : [];
                    const protocol = availableProtocols.includes(form.protocol) ? form.protocol : availableProtocols[0] ?? form.protocol;
                    setForm({ ...form, bridgeId, serverId: undefined, protocol });
                  }}
                  size="small"
                  fullWidth
                  helperText="Peer станет клиентом этого моста"
                >
                  <MenuItem value="">— без моста —</MenuItem>
                  {bridges.map((b) => (
                    <MenuItem key={b.id} value={b.id}>
                      {b.name}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {!form.bridgeId && (canManageAnyOrg ? (servers?.length ?? 0) > 0 : (allowedServers?.length ?? 0) > 0) && (
                <TextField
                  select
                  label={canManageAnyOrg ? 'Сервер (авто, если не выбран)' : 'Сервер'}
                  value={form.serverId || ''}
                  onChange={(e) => {
                    const serverId = e.target.value || undefined;
                    const selected = servers?.find((s) => s.id === serverId);
                    // У self-сервера обычно только один установленный протокол (тот, что
                    // выбрали при создании моста — WireGuard или AmneziaWG). Подставляем его
                    // автоматически, иначе комбинация протокол+сервер может не найтись.
                    // Есть только для super_admin/engineer — у остальных ролей allowedServers
                    // не содержит protocols, оставляем протокол как есть.
                    const activeProtocol = selected?.protocols.find((p) => p.status === 'active')?.protocol;
                    setForm({ ...form, serverId, protocol: activeProtocol ?? form.protocol });
                  }}
                  size="small"
                  fullWidth
                  helperText="Обычный сервер — в обход моста"
                >
                  {canManageAnyOrg && <MenuItem value="">Автоматически (балансировка)</MenuItem>}
                  {canManageAnyOrg
                    ? servers?.map((s) => (
                        <MenuItem key={s.id} value={s.id}>
                          {s.name}
                          {s.isSelf && ' (используется мостом)'}
                        </MenuItem>
                      ))
                    : allowedServers?.map((s) => (
                        <MenuItem key={s.id} value={s.id}>
                          {s.name}
                        </MenuItem>
                      ))}
                </TextField>
              )}
              {!canManageAnyOrg && (!bridges || bridges.length === 0) && (!allowedServers || allowedServers.length === 0) && (
                <Alert severity="warning">
                  Администратор ещё не выдал вашей организации доступ ни к одному серверу или мосту — создание peer недоступно.
                </Alert>
              )}
              {canManageAnyOrg && (
                <TextField
                  select
                  label="Клиент"
                  value={clientOrgId}
                  onChange={(e) => setClientOrgId(e.target.value)}
                  size="small"
                  fullWidth
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
              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={
                  createMutation.isPending ||
                  (canManageAnyOrg && !clientOrgId) ||
                  (!canManageAnyOrg && (!bridges || bridges.length === 0) && (!allowedServers || allowedServers.length === 0))
                }
              >
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

        <Paper sx={{ p: 2, width: '100%', flex: 1, minWidth: 0 }}>
          <TextField
            size="small"
            label="Поиск (название, IP, сервер)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ mb: 2, minWidth: 280 }}
          />
          <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sortDirection={sortKey === 'name' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'name'} direction={sortKey === 'name' ? sortDir : 'asc'} onClick={() => toggleSort('name')}>
                    Название
                  </TableSortLabel>
                </TableCell>
                <TableCell>Протокол/IP</TableCell>
                <TableCell sortDirection={sortKey === 'server' ? sortDir : false}>
                  <TableSortLabel
                    active={sortKey === 'server'}
                    direction={sortKey === 'server' ? sortDir : 'asc'}
                    onClick={() => toggleSort('server')}
                  >
                    Сервер
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === 'status' ? sortDir : false}>
                  <TableSortLabel
                    active={sortKey === 'status'}
                    direction={sortKey === 'status' ? sortDir : 'asc'}
                    onClick={() => toggleSort('status')}
                  >
                    Статус
                  </TableSortLabel>
                </TableCell>
                <TableCell align="right">Действия</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visiblePeers.map((peer) => (
                <TableRow key={peer.id}>
                  <TableCell>{peer.name}</TableCell>
                  <TableCell>{peer.allowedIp}</TableCell>
                  <TableCell>{serverLabel(peer, bridges)}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Chip size="small" label={peer.status} color={statusColor[peer.status]} />
                      {peer.needsRecreation && (
                        <Chip
                          size="small"
                          color="warning"
                          label="нужно пересоздать"
                          title="Ключ не расшифровывается текущим ключом шифрования панели (обычно после восстановления БД на другом сервере) — отзовите и создайте заново"
                        />
                      )}
                      {isSuperAdmin && peer.isExpired && (
                        <Chip
                          size="small"
                          color="error"
                          label="истёк"
                          title={`Срок действия истёк ${new Date(peer.expiresAt!).toLocaleDateString()} — peer не отозван, но не применяется на сервере (интернета нет)`}
                        />
                      )}
                      {isSuperAdmin && !peer.isExpired && peer.expiresAt && (
                        <Chip size="small" variant="outlined" label={`до ${new Date(peer.expiresAt).toLocaleDateString()}`} />
                      )}
                      {peer.pairedPeerId && (
                        <Chip
                          size="small"
                          variant="outlined"
                          color="info"
                          label="мультиконфиг"
                          title="Часть пары WireGuard + AmneziaWG — отзыв/переименование/срок действия применяются к обоим сразу"
                        />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.25} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                      <Tooltip title="Изменить">
                        <IconButton size="small" onClick={() => openEdit(peer)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Скачать конфиг">
                        <span>
                          <IconButton
                            size="small"
                            disabled={peer.source === 'imported'}
                            onClick={() => downloadPeerConfig(peer.id, peer.name)}
                          >
                            <DownloadIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="QR-код">
                        <span>
                          <IconButton size="small" disabled={peer.source === 'imported'} onClick={() => handleShowQr(peer)}>
                            <QrCode2Icon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Скачать .vpn для приложения AmneziaVPN">
                        <span>
                          <IconButton
                            size="small"
                            disabled={peer.source === 'imported'}
                            onClick={() => downloadPeerAmneziaConfig(peer.id, peer.name)}
                          >
                            <PhonelinkRingIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      {peer.status === 'active' && (
                        <Tooltip title="Отозвать">
                          <IconButton size="small" color="warning" onClick={() => revokeMutation.mutate(peer.id)}>
                            <BlockIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      {peer.status === 'revoked' && (
                        <Tooltip title="Удалить">
                          <IconButton size="small" color="error" onClick={() => purgeMutation.mutate(peer.id)}>
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && visiblePeers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>{search ? 'Ничего не найдено' : 'Peers пока нет'}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </TableContainer>
        </Paper>
      </Stack>

      <Dialog open={!!qrPeer} onClose={() => setQrPeer(null)}>
        <DialogTitle>QR-код: {qrPeer?.name}</DialogTitle>
        <DialogContent>{qrUrl && <img src={qrUrl} alt="QR-код конфигурации" width={320} height={320} />}</DialogContent>
      </Dialog>

      <Dialog open={!!editingPeer} onClose={() => setEditingPeer(null)} fullWidth maxWidth="xs">
        <DialogTitle>Изменить peer</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Название" value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
            {isSuperAdmin && (
              <TextField
                select
                label="Клиент"
                value={editOrgId}
                onChange={(e) => setEditOrgId(e.target.value)}
                helperText="Организация, к которой привязан peer"
              >
                <MenuItem value={NO_CLIENT}>Без клиента</MenuItem>
                {organizations?.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {isSuperAdmin && (
              <>
                <FormControlLabel
                  control={<Checkbox checked={editUnlimited} onChange={(e) => setEditUnlimited(e.target.checked)} />}
                  label="Бессрочно"
                />
                {!editUnlimited && (
                  <TextField
                    label="Действует до"
                    type="date"
                    value={editExpiresAt}
                    onChange={(e) => setEditExpiresAt(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    helperText="После этой даты peer не удаляется и не отзывается — просто перестаёт давать интернет"
                  />
                )}
              </>
            )}
            {editError && <Alert severity="error">{editError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingPeer(null)}>Отмена</Button>
          <Button
            variant="contained"
            disabled={updateMutation.isPending || !editName || (isSuperAdmin && !editUnlimited && !editExpiresAt)}
            onClick={() => updateMutation.mutate()}
          >
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
