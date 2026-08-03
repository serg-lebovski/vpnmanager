import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import {
  BridgeClientProtocolInput,
  CreateBridgeInput,
  createBridge,
  deleteBridge,
  fetchBridges,
  rebalanceBridge,
  setBridgeMode,
  setBridgeUpstream,
  updateBridge,
} from '../api/bridges';
import { getErrorMessage } from '../api/errors';
import { fetchOrganizations } from '../api/organizations';
import { fetchServers } from '../api/servers';
import { BridgeEntity, Organization, ServerEntity, VpnProtocol } from '../api/types';

const statusColor: Record<string, 'default' | 'success' | 'error' | 'warning'> = {
  not_configured: 'default',
  configuring: 'warning',
  active: 'success',
  error: 'error',
};

interface ProtocolRowState {
  enabled: boolean;
  listenPort: number;
  networkCidr: string;
}

export function BridgePage() {
  const queryClient = useQueryClient();
  const { data: bridges, isLoading } = useQuery({ queryKey: ['bridges'], queryFn: fetchBridges });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: fetchServers });
  const { data: organizations } = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bridges'] });

  const deleteMutation = useMutation({ mutationFn: deleteBridge, onSuccess: invalidate });

  const [name, setName] = useState('Мост');
  const [selfServerId, setSelfServerId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [wireguard, setWireguard] = useState<ProtocolRowState>({ enabled: true, listenPort: 51820, networkCidr: '10.9.0.0/24' });
  const [amneziawg, setAmneziawg] = useState<ProtocolRowState>({ enabled: false, listenPort: 51821, networkCidr: '10.9.1.0/24' });
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createBridge,
    onSuccess: () => {
      invalidate();
      setCreateError(null);
    },
    onError: (err) => setCreateError(getErrorMessage(err, 'Не удалось создать мост')),
  });

  function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const clientProtocols: BridgeClientProtocolInput[] = [];
    if (wireguard.enabled) {
      clientProtocols.push({ protocol: 'wireguard', listenPort: wireguard.listenPort, networkCidr: wireguard.networkCidr });
    }
    if (amneziawg.enabled) {
      clientProtocols.push({ protocol: 'amneziawg', listenPort: amneziawg.listenPort, networkCidr: amneziawg.networkCidr });
    }
    if (clientProtocols.length === 0) {
      setCreateError('Выберите хотя бы один протокол для клиентов моста');
      return;
    }
    const input: CreateBridgeInput = { name, selfServerId, clientProtocols };
    if (organizationId) {
      input.organizationId = organizationId;
    }
    createMutation.mutate(input);
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Мосты</Typography>
      <Typography variant="body2" color="text.secondary">
        Поднимает WireGuard и/или AmneziaWG прямо на сервере панели — клиенты моста
        подключаются к нему один раз, их конфиг больше не меняется. Через какой именно
        backend-сервер идёт трафик — переключается ниже, в любой момент, без
        переподключения устройств (все клиенты моста используют общий upstream-туннель,
        переключение затрагивает их всех сразу). На одном self-сервере можно создать
        несколько мостов (разные порты) — например, отдельный на каждую организацию.
      </Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Создать мост
        </Typography>
        <form onSubmit={handleCreateSubmit}>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
            <TextField label="Название" value={name} onChange={(e) => setName(e.target.value)} required />
            <TextField
              select
              label="Сервер панели (self)"
              value={selfServerId}
              onChange={(e) => setSelfServerId(e.target.value)}
              sx={{ minWidth: 220 }}
              helperText="Сервер, добавленный на вкладке «Серверы», указывающий на хост самой панели"
              required
            >
              {servers?.map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.name} ({s.host})
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Организация"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              sx={{ minWidth: 200 }}
              helperText="Пусто — общий мост, виден только суперадмину"
            >
              <MenuItem value="">Общий (без организации)</MenuItem>
              {organizations?.map((org) => (
                <MenuItem key={org.id} value={org.id}>
                  {org.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Typography variant="body2" color="text.secondary" mt={2} mb={1}>
            Протоколы для клиентов моста (можно оба сразу — peers по каждому пойдут через
            один и тот же upstream):
          </Typography>
          <Stack spacing={1}>
            <ProtocolRow
              label="WireGuard"
              state={wireguard}
              onChange={setWireguard}
              helperText="Работает везде, где WireGuard не блокируется DPI"
            />
            <ProtocolRow
              label="AmneziaWG"
              state={amneziawg}
              onChange={setAmneziawg}
              helperText="Обфусцированный — нужен там, где обычный WireGuard блокируется/детектится"
            />
          </Stack>

          <Button type="submit" variant="contained" disabled={createMutation.isPending} sx={{ mt: 2 }}>
            Создать
          </Button>
        </form>
        {createError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {createError}
          </Alert>
        )}
      </Paper>

      {isLoading && <Typography>Загрузка...</Typography>}

      {bridges?.map((bridge) => (
        <BridgeCard
          key={bridge.id}
          bridge={bridge}
          servers={servers || []}
          organizations={organizations || []}
          onChanged={invalidate}
          onDelete={() => deleteMutation.mutate(bridge.id)}
        />
      ))}
    </Stack>
  );
}

function ProtocolRow({
  label,
  state,
  onChange,
  helperText,
}: {
  label: string;
  state: ProtocolRowState;
  onChange: (state: ProtocolRowState) => void;
  helperText: string;
}) {
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <FormControlLabel
        sx={{ minWidth: 160 }}
        control={<Checkbox checked={state.enabled} onChange={(e) => onChange({ ...state, enabled: e.target.checked })} />}
        label={label}
      />
      <TextField
        label="Порт"
        type="number"
        size="small"
        disabled={!state.enabled}
        value={state.listenPort}
        onChange={(e) => onChange({ ...state, listenPort: Number(e.target.value) })}
        sx={{ width: 120 }}
      />
      <TextField
        label="Сеть клиентов (CIDR)"
        size="small"
        disabled={!state.enabled}
        value={state.networkCidr}
        onChange={(e) => onChange({ ...state, networkCidr: e.target.value })}
        sx={{ width: 180 }}
      />
      <Typography variant="body2" color="text.secondary">
        {helperText}
      </Typography>
    </Stack>
  );
}

function BridgeCard({
  bridge,
  servers,
  organizations,
  onChanged,
  onDelete,
}: {
  bridge: BridgeEntity;
  servers: ServerEntity[];
  organizations: Organization[];
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [selectedUpstream, setSelectedUpstream] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(bridge.name);
  const [editOrganizationId, setEditOrganizationId] = useState(bridge.organizationId ?? '');

  const organizationName = organizations.find((o) => o.id === bridge.organizationId)?.name;

  const updateMutation = useMutation({
    mutationFn: () => updateBridge(bridge.id, { name: editName, organizationId: editOrganizationId || null }),
    onSuccess: () => {
      onChanged();
      setError(null);
      setIsEditing(false);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось сохранить изменения моста')),
  });

  const upstreamMutation = useMutation({
    mutationFn: (serverProtocolId: string) => setBridgeUpstream(bridge.id, serverProtocolId),
    onSuccess: () => {
      onChanged();
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось переключить upstream')),
  });
  const modeMutation = useMutation({
    mutationFn: (mode: 'manual' | 'auto') => setBridgeMode(bridge.id, mode),
    onSuccess: onChanged,
    onError: (err) => setError(getErrorMessage(err, 'Не удалось сменить режим')),
  });
  const rebalanceMutation = useMutation({
    mutationFn: () => rebalanceBridge(bridge.id),
    onSuccess: () => {
      onChanged();
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось пересчитать баланс')),
  });

  const clientProtocolIds = [bridge.wireguardClientProtocolId, bridge.amneziawgClientProtocolId].filter(Boolean);
  const candidates = servers
    .flatMap((server) => server.protocols.map((protocol) => ({ ...protocol, serverName: server.name, host: server.host })))
    .filter((protocol) => protocol.status === 'active' && !clientProtocolIds.includes(protocol.id));

  const clientInterfaces: Array<{ label: VpnProtocol; sp: BridgeEntity['wireguardClientProtocol'] }> = [
    { label: 'wireguard', sp: bridge.wireguardClientProtocol },
    { label: 'amneziawg', sp: bridge.amneziawgClientProtocol },
  ].filter((row) => row.sp) as Array<{ label: VpnProtocol; sp: BridgeEntity['wireguardClientProtocol'] }>;

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Box flex={1}>
          {isEditing ? (
            <Stack direction="row" spacing={2} alignItems="flex-start" mb={1}>
              <TextField label="Название" size="small" value={editName} onChange={(e) => setEditName(e.target.value)} required />
              <TextField
                select
                label="Организация"
                size="small"
                value={editOrganizationId}
                onChange={(e) => setEditOrganizationId(e.target.value)}
                sx={{ minWidth: 200 }}
              >
                <MenuItem value="">Общий (без организации)</MenuItem>
                {organizations.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}
                  </MenuItem>
                ))}
              </TextField>
              <Button size="small" variant="contained" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate()}>
                Сохранить
              </Button>
              <Button size="small" onClick={() => setIsEditing(false)}>
                Отмена
              </Button>
            </Stack>
          ) : (
            <Typography variant="h6">
              {bridge.name} <Chip size="small" label={bridge.status} color={statusColor[bridge.status]} sx={{ ml: 1 }} />
              <Chip size="small" label={organizationName ?? 'общий'} variant="outlined" sx={{ ml: 1 }} />
            </Typography>
          )}
          {clientInterfaces.map(({ label, sp }) => (
            <Typography key={label} variant="body2" color="text.secondary">
              Клиентский интерфейс ({label}): {sp?.server?.name} · порт {sp?.listenPort} · сеть {sp?.networkCidr}
            </Typography>
          ))}
          <Typography variant="body2" color="text.secondary">
            Upstream:{' '}
            {bridge.upstreamServerProtocol
              ? `${bridge.upstreamServerProtocol.server?.name} (${bridge.upstreamServerProtocol.protocol})`
              : 'не настроен'}
          </Typography>
          {bridge.lastError && (
            <Typography variant="body2" color="error">
              {bridge.lastError}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2">Авто-баланс</Typography>
          <Switch
            checked={bridge.upstreamMode === 'auto'}
            onChange={(e) => modeMutation.mutate(e.target.checked ? 'auto' : 'manual')}
            disabled={!bridge.upstreamServerProtocolId}
          />
          <Button size="small" onClick={() => rebalanceMutation.mutate()} disabled={!bridge.upstreamServerProtocolId}>
            Пересчитать баланс
          </Button>
          {!isEditing && (
            <Button
              size="small"
              onClick={() => {
                setEditName(bridge.name);
                setEditOrganizationId(bridge.organizationId ?? '');
                setIsEditing(true);
              }}
            >
              Изменить
            </Button>
          )}
          <Button size="small" color="error" onClick={onDelete}>
            Удалить
          </Button>
        </Stack>
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Stack direction="row" spacing={2} alignItems="flex-start">
        <TextField
          select
          label="Переключить upstream вручную"
          value={selectedUpstream}
          onChange={(e) => setSelectedUpstream(e.target.value)}
          sx={{ minWidth: 260 }}
        >
          {candidates.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.serverName} — {c.protocol} ({c.host})
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="outlined"
          disabled={!selectedUpstream || upstreamMutation.isPending}
          onClick={() => upstreamMutation.mutate(selectedUpstream)}
        >
          Переключить
        </Button>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
    </Paper>
  );
}
