import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
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
import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import {
  BridgeClientProtocolInput,
  CreateBridgeInput,
  createBridge,
  deleteBridge,
  fetchBridges,
  fetchCandidateStatus,
  rebalanceBridge,
  setBridgeMode,
  setBridgeUpstream,
  setUpstreamCandidates,
  updateBridge,
} from '../api/bridges';
import { BridgeSwitchProgress, connectBridgeProgressSocket } from '../api/bridgeSocket';
import { getErrorMessage } from '../api/errors';
import { fetchOrganizations } from '../api/organizations';
import { fetchServers } from '../api/servers';
import { BridgeEntity, BridgeUpstreamMode, Organization, ServerEntity, SshAuthType, VpnProtocol } from '../api/types';

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

  const [progressByBridge, setProgressByBridge] = useState<Record<string, BridgeSwitchProgress>>({});

  useEffect(() => {
    const socket = connectBridgeProgressSocket((progress) => {
      setProgressByBridge((prev) => ({ ...prev, [progress.bridgeId]: progress }));
      if (progress.done) {
        invalidate();
        // Даём секунду увидеть "Готово"/ошибку, потом убираем прогресс-бар — дальше
        // актуальное состояние моста видно по обычным полям карточки.
        setTimeout(() => {
          setProgressByBridge((prev) => {
            const { [progress.bridgeId]: _omit, ...rest } = prev;
            return rest;
          });
        }, 1500);
      }
    });
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [name, setName] = useState('Мост');
  const [organizationId, setOrganizationId] = useState('');
  const [wireguard, setWireguard] = useState<ProtocolRowState>({ enabled: true, listenPort: 51820, networkCidr: '10.9.0.0/24' });
  const [amneziawg, setAmneziawg] = useState<ProtocolRowState>({ enabled: false, listenPort: 51821, networkCidr: '10.9.1.0/24' });
  const [createError, setCreateError] = useState<string | null>(null);

  // Self-сервер (хост панели) переиспользуется для всех мостов автоматически — форма
  // просит SSH-доступ к нему только при создании самого первого моста в системе, когда
  // такого сервера ещё нет вообще (см. BridgesService.create).
  const hasSelfServer = servers?.some((s) => s.isSelf) ?? false;
  const [selfHost, setSelfHost] = useState('');
  const [selfSshPort, setSelfSshPort] = useState(22);
  const [selfSshUsername, setSelfSshUsername] = useState('root');
  const [selfSshAuthType, setSelfSshAuthType] = useState<SshAuthType>('password');
  const [selfSecret, setSelfSecret] = useState('');

  const createMutation = useMutation({
    mutationFn: createBridge,
    onSuccess: () => {
      invalidate();
      setCreateError(null);
      setSelfSecret('');
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
    const input: CreateBridgeInput = { name, clientProtocols };
    if (organizationId) {
      input.organizationId = organizationId;
    }
    if (!hasSelfServer) {
      if (!selfHost || !selfSecret) {
        setCreateError('Укажите SSH-доступ к серверу, на котором развёрнута панель');
        return;
      }
      input.selfServerCredentials = {
        host: selfHost,
        sshPort: selfSshPort,
        sshUsername: selfSshUsername,
        sshAuthType: selfSshAuthType,
        secret: selfSecret,
      };
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
            Протоколы, которые панель установит у себя для клиентов моста (можно оба сразу
            — peers по каждому пойдут через один и тот же upstream):
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

          {!hasSelfServer && (
            <>
              <Typography variant="body2" color="text.secondary" mt={2} mb={1}>
                Мостов пока нет — укажите SSH-доступ к серверу, на котором развёрнута сама
                панель, чтобы поставить на нём выбранные протоколы. Нужно только один раз:
                следующие мосты переиспользуют этот же сервер (появится на вкладке
                «Серверы» под именем «Этот сервер»).
              </Typography>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
                <TextField
                  label="Хост / IP панели"
                  value={selfHost}
                  onChange={(e) => setSelfHost(e.target.value)}
                  sx={{ minWidth: 200 }}
                  required
                />
                <TextField
                  label="SSH порт"
                  type="number"
                  value={selfSshPort}
                  onChange={(e) => setSelfSshPort(Number(e.target.value))}
                  sx={{ width: 120 }}
                />
                <TextField
                  label="SSH пользователь"
                  value={selfSshUsername}
                  onChange={(e) => setSelfSshUsername(e.target.value)}
                  sx={{ minWidth: 140 }}
                />
                <TextField
                  select
                  label="Тип авторизации"
                  value={selfSshAuthType}
                  onChange={(e) => setSelfSshAuthType(e.target.value as SshAuthType)}
                  sx={{ minWidth: 180 }}
                >
                  <MenuItem value="password">Пароль</MenuItem>
                  <MenuItem value="private_key">Приватный ключ</MenuItem>
                </TextField>
                <TextField
                  label={selfSshAuthType === 'password' ? 'Пароль' : 'Приватный ключ (PEM)'}
                  type={selfSshAuthType === 'password' ? 'password' : 'text'}
                  multiline={selfSshAuthType === 'private_key'}
                  value={selfSecret}
                  onChange={(e) => setSelfSecret(e.target.value)}
                  sx={{ minWidth: 220 }}
                  required
                />
              </Stack>
            </>
          )}

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
          progress={progressByBridge[bridge.id]}
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
  progress,
  onChanged,
  onDelete,
}: {
  bridge: BridgeEntity;
  servers: ServerEntity[];
  organizations: Organization[];
  progress?: BridgeSwitchProgress;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [selectedUpstream, setSelectedUpstream] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(bridge.name);
  const [editOrganizationId, setEditOrganizationId] = useState(bridge.organizationId ?? '');
  const [editDomainName, setEditDomainName] = useState(bridge.domainName ?? '');
  // Список обхода upstream — редактируется как текст, по записи на строку (домен или
  // IP/CIDR); при сохранении разбивается на массив, пустые строки и строки-комментарии
  // (начинающиеся с #) отбрасываются.
  const [editBypassText, setEditBypassText] = useState((bridge.bypassDestinations ?? []).join('\n'));

  const organizationName = organizations.find((o) => o.id === bridge.organizationId)?.name;

  function parseBypassText(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  function handleBypassFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const uploaded = parseBypassText(String(reader.result ?? ''));
      const existing = parseBypassText(editBypassText);
      setEditBypassText(Array.from(new Set([...existing, ...uploaded])).join('\n'));
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  const updateMutation = useMutation({
    mutationFn: () =>
      updateBridge(bridge.id, {
        name: editName,
        organizationId: editOrganizationId || null,
        domainName: editDomainName.trim() || null,
        bypassDestinations: parseBypassText(editBypassText),
      }),
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
    mutationFn: (mode: BridgeUpstreamMode) => setBridgeMode(bridge.id, mode),
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

  const [isEditingCandidates, setIsEditingCandidates] = useState(false);
  const [candidatePriority, setCandidatePriority] = useState<Record<string, number | ''>>({});

  const candidatesMutation = useMutation({
    mutationFn: (serverProtocolIds: string[]) => setUpstreamCandidates(bridge.id, serverProtocolIds),
    onSuccess: () => {
      onChanged();
      setError(null);
      setIsEditingCandidates(false);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось сохранить список кандидатов')),
  });

  const { data: candidateStatus } = useQuery({
    queryKey: ['bridge-candidate-status', bridge.id],
    queryFn: () => fetchCandidateStatus(bridge.id),
    enabled: bridge.upstreamMode === 'failover' || isEditingCandidates,
    refetchInterval: 20_000,
  });

  function openCandidateEditor() {
    const initial: Record<string, number | ''> = {};
    bridge.upstreamCandidates.forEach((c) => {
      if (c.serverProtocol) {
        initial[c.serverProtocol.id] = c.priority;
      }
    });
    setCandidatePriority(initial);
    setIsEditingCandidates(true);
  }

  function saveCandidates() {
    const entries = Object.entries(candidatePriority).filter((entry): entry is [string, number] => entry[1] !== '');
    entries.sort((a, b) => a[1] - b[1]);
    const serverProtocolIds = entries.map(([id]) => id);
    if (serverProtocolIds.length === 0) {
      setError('Выберите хотя бы основной сервер');
      return;
    }
    candidatesMutation.mutate(serverProtocolIds);
  }

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
            <Stack spacing={1.5} mb={1}>
              <Stack direction="row" spacing={2} alignItems="flex-start" flexWrap="wrap" useFlexGap>
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
                <TextField
                  label="Доменное имя моста"
                  size="small"
                  value={editDomainName}
                  onChange={(e) => setEditDomainName(e.target.value)}
                  sx={{ minWidth: 220 }}
                  helperText="Вместо IP self-сервера в скачиваемых конфигах peers"
                />
                <Button size="small" variant="contained" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate()}>
                  Сохранить
                </Button>
                <Button size="small" onClick={() => setIsEditing(false)}>
                  Отмена
                </Button>
              </Stack>
              <Stack spacing={0.5} alignItems="flex-start" sx={{ maxWidth: 480 }}>
                <TextField
                  label="Список обхода upstream (домены/IP, по одному на строку)"
                  size="small"
                  multiline
                  minRows={3}
                  maxRows={8}
                  fullWidth
                  value={editBypassText}
                  onChange={(e) => setEditBypassText(e.target.value)}
                  helperText="Трафик к этим доменам/IP пойдёт напрямую с self-сервера, минуя upstream ('зарубежный' сервер)"
                />
                <Button size="small" component="label">
                  Загрузить .txt
                  <input type="file" accept=".txt" hidden onChange={handleBypassFileUpload} />
                </Button>
              </Stack>
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
            Домен: {bridge.domainName ?? 'не задан (в конфигах — IP self-сервера)'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Обход upstream:{' '}
            {bridge.bypassDestinations?.length > 0 ? `${bridge.bypassDestinations.length} записей` : 'не задан'}
          </Typography>
          {bridge.lastError && (
            <Typography variant="body2" color="error">
              {bridge.lastError}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            select
            size="small"
            label="Режим upstream"
            value={bridge.upstreamMode}
            onChange={(e) => modeMutation.mutate(e.target.value as BridgeUpstreamMode)}
            disabled={(progress && !progress.done) || modeMutation.isPending}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="manual">Ручной</MenuItem>
            <MenuItem value="auto" disabled={!bridge.upstreamServerProtocolId}>
              Авто (по нагрузке)
            </MenuItem>
            <MenuItem value="failover" disabled={bridge.upstreamCandidates.length === 0}>
              Failover (по доступности)
            </MenuItem>
          </TextField>
          <Button
            size="small"
            onClick={() => rebalanceMutation.mutate()}
            disabled={!bridge.upstreamServerProtocolId || (progress && !progress.done)}
          >
            Пересчитать баланс
          </Button>
          {!isEditing && (
            <Button
              size="small"
              onClick={() => {
                setEditName(bridge.name);
                setEditOrganizationId(bridge.organizationId ?? '');
                setEditDomainName(bridge.domainName ?? '');
                setEditBypassText((bridge.bypassDestinations ?? []).join('\n'));
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

      {progress && !progress.done ? (
        <Stack direction="row" spacing={2} alignItems="center">
          <CircularProgress variant="determinate" value={progress.percent} size={32} />
          <Typography variant="body2">
            {progress.percent}% — {progress.step}
          </Typography>
        </Stack>
      ) : (
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
      )}

      <Divider sx={{ my: 2 }} />

      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography variant="subtitle2">Приоритет upstream (для режима Failover)</Typography>
        {!isEditingCandidates && (
          <Button size="small" onClick={openCandidateEditor}>
            Настроить
          </Button>
        )}
      </Stack>

      {!isEditingCandidates ? (
        bridge.upstreamCandidates.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Основной и резервные серверы не заданы — режим Failover недоступен.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {bridge.upstreamCandidates.map((c) => {
              const serverId = c.serverProtocol?.server?.id;
              const reachable = serverId ? candidateStatus?.[serverId] : undefined;
              return (
                <Stack key={c.id} direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    label={c.priority === 0 ? 'Основной' : `Резерв ${c.priority}`}
                    color={c.priority === 0 ? 'primary' : 'default'}
                    variant="outlined"
                  />
                  <Typography variant="body2">
                    {c.serverProtocol?.server?.name} ({c.serverProtocol?.protocol})
                  </Typography>
                  {reachable !== undefined && (
                    <Chip
                      size="small"
                      label={reachable === null ? 'проверяем…' : reachable ? 'доступен' : 'недоступен'}
                      color={reachable === null ? 'default' : reachable ? 'success' : 'error'}
                    />
                  )}
                </Stack>
              );
            })}
          </Stack>
        )
      ) : (
        <Stack spacing={1}>
          {candidates.map((c) => (
            <Stack key={c.id} direction="row" spacing={2} alignItems="center">
              <TextField
                select
                size="small"
                label={`${c.serverName} — ${c.protocol} (${c.host})`}
                value={candidatePriority[c.id] ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  setCandidatePriority((prev) => ({ ...prev, [c.id]: value === '' ? '' : Number(value) }));
                }}
                sx={{ minWidth: 320 }}
              >
                <MenuItem value="">Не участвует</MenuItem>
                {candidates.map((_, idx) => (
                  <MenuItem key={idx} value={idx}>
                    {idx === 0 ? 'Основной' : `Резерв ${idx}`}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          ))}
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="contained" disabled={candidatesMutation.isPending} onClick={saveCandidates}>
              Сохранить
            </Button>
            <Button size="small" onClick={() => setIsEditingCandidates(false)}>
              Отмена
            </Button>
          </Stack>
        </Stack>
      )}

      {progress?.done && progress.error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {progress.error}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
    </Paper>
  );
}
