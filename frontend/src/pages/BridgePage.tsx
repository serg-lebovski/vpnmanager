import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { CreateBridgeInput, createBridge, fetchBridges, rebalanceBridge, setBridgeMode, setBridgeUpstream } from '../api/bridges';
import { getErrorMessage } from '../api/errors';
import { fetchServers } from '../api/servers';
import { BridgeEntity, ServerEntity } from '../api/types';

const statusColor: Record<string, 'default' | 'success' | 'error' | 'warning'> = {
  not_configured: 'default',
  configuring: 'warning',
  active: 'success',
  error: 'error',
};

export function BridgePage() {
  const queryClient = useQueryClient();
  const { data: bridges, isLoading } = useQuery({ queryKey: ['bridges'], queryFn: fetchBridges });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: fetchServers });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bridges'] });

  const [form, setForm] = useState<CreateBridgeInput>({
    name: 'Мост',
    selfServerId: '',
    listenPort: 51821,
    networkCidr: '10.9.0.0/24',
  });
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
    createMutation.mutate(form);
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Мост</Typography>
      <Typography variant="body2" color="text.secondary">
        Поднимает WireGuard прямо на сервере панели — клиенты моста подключаются к нему
        обычным WireGuard-клиентом, а сам мост маршрутизирует их трафик через один из уже
        добавленных backend-серверов (общий upstream-туннель на всех клиентов моста).
      </Typography>

      {!isLoading && bridges?.length === 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" mb={2}>
            Создать мост
          </Typography>
          <form onSubmit={handleCreateSubmit}>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
              <TextField label="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <TextField
                select
                label="Сервер панели (self)"
                value={form.selfServerId}
                onChange={(e) => setForm({ ...form, selfServerId: e.target.value })}
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
                label="Порт"
                type="number"
                value={form.listenPort}
                onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) })}
                sx={{ width: 120 }}
              />
              <TextField
                label="Сеть клиентов (CIDR)"
                value={form.networkCidr}
                onChange={(e) => setForm({ ...form, networkCidr: e.target.value })}
                sx={{ width: 180 }}
              />
              <Button type="submit" variant="contained" disabled={createMutation.isPending}>
                Создать
              </Button>
            </Stack>
          </form>
          {createError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {createError}
            </Alert>
          )}
        </Paper>
      )}

      {bridges?.map((bridge) => (
        <BridgeCard key={bridge.id} bridge={bridge} servers={servers || []} onChanged={invalidate} />
      ))}
    </Stack>
  );
}

function BridgeCard({
  bridge,
  servers,
  onChanged,
}: {
  bridge: BridgeEntity;
  servers: ServerEntity[];
  onChanged: () => void;
}) {
  const [selectedUpstream, setSelectedUpstream] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  const candidates = servers
    .flatMap((server) => server.protocols.map((protocol) => ({ ...protocol, serverName: server.name, host: server.host })))
    .filter((protocol) => protocol.status === 'active' && protocol.id !== bridge.clientServerProtocolId);

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography variant="h6">
            {bridge.name} <Chip size="small" label={bridge.status} color={statusColor[bridge.status]} sx={{ ml: 1 }} />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Клиентский интерфейс: {bridge.clientServerProtocol?.server?.name} · порт{' '}
            {bridge.clientServerProtocol?.listenPort} · сеть {bridge.clientServerProtocol?.networkCidr}
          </Typography>
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
