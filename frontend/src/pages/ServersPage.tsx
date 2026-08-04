import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { connectDashboardSocket } from '../api/dashboard';
import { getErrorMessage } from '../api/errors';
import {
  CreateServerInput,
  DetectionResult,
  UpdateServerCredentialsInput,
  createServer,
  deleteServer,
  detectExistingInstallations,
  fetchServers,
  installProtocol,
  rebootServer,
  scanAndImportPeers,
  testServerConnection,
  updateServer,
  updateServerCredentials,
} from '../api/servers';
import { ServerEntity, SshAuthType, VpnProtocol } from '../api/types';

const statusColor: Record<string, 'default' | 'success' | 'error' | 'warning'> = {
  unknown: 'default',
  online: 'success',
  offline: 'error',
  not_installed: 'default',
  installing: 'warning',
  active: 'success',
  error: 'error',
};

export function ServersPage() {
  const queryClient = useQueryClient();
  const { data: servers, isLoading } = useQuery({
    queryKey: ['servers'],
    queryFn: fetchServers,
    // Пока хотя бы один протокол в процессе установки, поллим статус почаще, чтобы
    // видеть прогресс без ручного обновления страницы — сама установка идёт по SSH
    // синхронно на бэкенде и может занимать минуты (apt-get и т.п.).
    refetchInterval: (query) => {
      const data = query.state.data as ServerEntity[] | undefined;
      const hasInstalling = data?.some((server) => server.protocols.some((sp) => sp.status === 'installing'));
      return hasInstalling ? 3000 : false;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['servers'] });

  // Живой статус связи с сервером — переиспользуем тот же WebSocket-канал, что и
  // дашборд (backend уже опрашивает все серверы по SSH каждые несколько секунд для
  // него), отдельного механизма опроса заводить не нужно.
  const [onlineByServer, setOnlineByServer] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const socket = connectDashboardSocket((snapshot) => {
      setOnlineByServer(Object.fromEntries(snapshot.servers.map((s) => [s.serverId, s.online])));
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  const [rebootConfirmId, setRebootConfirmId] = useState<string | null>(null);
  const rebootMutation = useMutation({
    mutationFn: rebootServer,
    onSuccess: () => setRebootConfirmId(null),
  });

  const [form, setForm] = useState<CreateServerInput>({
    name: '',
    host: '',
    sshPort: 22,
    sshUsername: 'root',
    sshAuthType: 'password',
    secret: '',
    maxPeers: 100,
  });
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createServer,
    onSuccess: () => {
      invalidate();
      setForm({ name: '', host: '', sshPort: 22, sshUsername: 'root', sshAuthType: 'password', secret: '', maxPeers: 100 });
      setCreateError(null);
    },
    onError: (err) => setCreateError(getErrorMessage(err, 'Не удалось добавить сервер')),
  });

  const deleteMutation = useMutation({ mutationFn: deleteServer, onSuccess: invalidate });
  const renameMutation = useMutation({
    mutationFn: (vars: { id: string; name: string }) => updateServer(vars.id, { name: vars.name }),
    onSuccess: invalidate,
  });
  const testMutation = useMutation({ mutationFn: testServerConnection, onSuccess: invalidate });
  const credentialsMutation = useMutation({
    mutationFn: (vars: { id: string; input: UpdateServerCredentialsInput }) => updateServerCredentials(vars.id, vars.input),
    onSuccess: invalidate,
  });
  const installMutation = useMutation({
    mutationFn: (vars: { serverId: string; protocol: VpnProtocol; listenPort: number; networkCidr: string }) =>
      installProtocol(vars.serverId, vars),
    onSuccess: invalidate,
  });
  const installError =
    installMutation.isError && installMutation.variables
      ? { serverId: installMutation.variables.serverId, message: getErrorMessage(installMutation.error, 'Не удалось установить протокол') }
      : null;
  const scanMutation = useMutation({ mutationFn: scanAndImportPeers, onSuccess: invalidate });

  function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate(form);
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Серверы (VPS)</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Добавить сервер
        </Typography>
        <form onSubmit={handleCreateSubmit}>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
            <TextField label="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <TextField label="Хост / IP" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} required />
            <TextField
              label="SSH порт"
              type="number"
              value={form.sshPort}
              onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) })}
              sx={{ width: 120 }}
            />
            <TextField
              label="SSH пользователь"
              value={form.sshUsername}
              onChange={(e) => setForm({ ...form, sshUsername: e.target.value })}
              required
            />
            <TextField
              select
              label="Тип авторизации"
              value={form.sshAuthType}
              onChange={(e) => setForm({ ...form, sshAuthType: e.target.value as SshAuthType })}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="password">Пароль</MenuItem>
              <MenuItem value="private_key">Приватный ключ</MenuItem>
            </TextField>
            <TextField
              label={form.sshAuthType === 'password' ? 'Пароль' : 'Приватный ключ (PEM)'}
              type={form.sshAuthType === 'password' ? 'password' : 'text'}
              multiline={form.sshAuthType === 'private_key'}
              value={form.secret}
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
              sx={{ minWidth: 240 }}
              required
            />
            <TextField
              label="Лимит peers"
              type="number"
              value={form.maxPeers}
              onChange={(e) => setForm({ ...form, maxPeers: Number(e.target.value) })}
              sx={{ width: 140 }}
            />
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              Добавить
            </Button>
          </Stack>
        </form>
        {createError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {createError}
          </Alert>
        )}
      </Paper>

      {isLoading && <Typography>Загрузка...</Typography>}

      {/* Self-серверы (используемые мостами) тоже показываем — у них может быть свободная
          ёмкость помимо клиентского интерфейса моста. Какой именно протокол занят каким
          мостом — видно по чипу "мост «Имя»" у самого протокола ниже. */}
      {servers?.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          online={onlineByServer[server.id]}
          onDelete={() => deleteMutation.mutate(server.id)}
          onRename={(name) => renameMutation.mutate({ id: server.id, name })}
          onTest={() => testMutation.mutate(server.id)}
          onReboot={() => setRebootConfirmId(server.id)}
          onUpdateCredentials={(input) => credentialsMutation.mutate({ id: server.id, input })}
          credentialsSaving={credentialsMutation.isPending && credentialsMutation.variables?.id === server.id}
          credentialsError={
            credentialsMutation.isError && credentialsMutation.variables?.id === server.id
              ? getErrorMessage(credentialsMutation.error, 'Не удалось сохранить учётные данные')
              : null
          }
          onInstall={(protocol, listenPort, networkCidr) =>
            installMutation.mutate({ serverId: server.id, protocol, listenPort, networkCidr })
          }
          isInstalling={installMutation.isPending && installMutation.variables?.serverId === server.id}
          installError={installError?.serverId === server.id ? installError.message : null}
          onScan={(serverProtocolId) => scanMutation.mutate(serverProtocolId)}
          onDetected={invalidate}
        />
      ))}

      <Dialog open={!!rebootConfirmId} onClose={() => setRebootConfirmId(null)}>
        <DialogTitle>Перезагрузить сервер?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            На сервер уйдёт команда <code>reboot</code> по SSH. Все текущие VPN-подключения клиентов к этому серверу
            прервутся до его повторной загрузки.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRebootConfirmId(null)}>Отмена</Button>
          <Button
            variant="contained"
            color="warning"
            disabled={rebootMutation.isPending}
            onClick={() => rebootConfirmId && rebootMutation.mutate(rebootConfirmId)}
          >
            Перезагрузить
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function ServerCard({
  server,
  online,
  onDelete,
  onRename,
  onTest,
  onReboot,
  onInstall,
  isInstalling,
  installError,
  onScan,
  onDetected,
  onUpdateCredentials,
  credentialsSaving,
  credentialsError,
}: {
  server: ServerEntity;
  online?: boolean;
  onDelete: () => void;
  onRename: (name: string) => void;
  onTest: () => void;
  onReboot: () => void;
  onInstall: (protocol: VpnProtocol, listenPort: number, networkCidr: string) => void;
  isInstalling: boolean;
  installError: string | null;
  onScan: (serverProtocolId: string) => void;
  onDetected: () => void;
  onUpdateCredentials: (input: UpdateServerCredentialsInput) => void;
  credentialsSaving: boolean;
  credentialsError: string | null;
}) {
  const [protocol, setProtocol] = useState<VpnProtocol>('wireguard');
  const [listenPort, setListenPort] = useState(51820);
  const [networkCidr, setNetworkCidr] = useState('10.8.0.0/24');
  const [detectResult, setDetectResult] = useState<DetectionResult[] | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(server.name);
  const [isEditingCredentials, setIsEditingCredentials] = useState(false);
  const [credAuthType, setCredAuthType] = useState<SshAuthType>('password');
  const [credSecret, setCredSecret] = useState('');

  const detectMutation = useMutation({
    mutationFn: () => detectExistingInstallations(server.id),
    onSuccess: (data) => {
      setDetectResult(data);
      onDetected();
    },
  });

  const protocolLabels: Record<VpnProtocol, string> = { wireguard: 'WireGuard', amneziawg: 'AmneziaWG' };

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box flex={1}>
          {isEditingName ? (
            <Stack direction="row" spacing={1} alignItems="center" mb={1}>
              <TextField size="small" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  onRename(editName);
                  setIsEditingName(false);
                }}
              >
                Сохранить
              </Button>
              <Button size="small" onClick={() => setIsEditingName(false)}>
                Отмена
              </Button>
            </Stack>
          ) : (
            <Typography variant="h6">
              {server.name} <Chip size="small" label={server.status} color={statusColor[server.status]} sx={{ ml: 1 }} />
              {server.isSelf && <Chip size="small" label="Мост (self)" color="info" sx={{ ml: 1 }} />}
              <Chip
                size="small"
                label={online === undefined ? 'проверяем связь…' : online ? 'на связи' : 'нет связи'}
                color={online === undefined ? 'default' : online ? 'success' : 'error'}
                variant="outlined"
                sx={{ ml: 1 }}
              />
              {server.needsCredentials && (
                <Chip size="small" label="нужны новые SSH-данные" color="warning" sx={{ ml: 1 }} />
              )}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {server.sshUsername}@{server.host}:{server.sshPort} · лимит {server.maxPeers} peers
          </Typography>
          {server.lastError && (
            <Typography variant="body2" color="error">
              {server.lastError}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={onTest}>
            Проверить подключение
          </Button>
          <Button size="small" onClick={() => detectMutation.mutate()} disabled={detectMutation.isPending}>
            Проверить существующую установку
          </Button>
          <Button size="small" color="warning" onClick={onReboot}>
            Перезагрузить
          </Button>
          {!isEditingName && (
            <Button
              size="small"
              onClick={() => {
                setEditName(server.name);
                setIsEditingName(true);
              }}
            >
              Переименовать
            </Button>
          )}
          <Button size="small" color="error" onClick={onDelete}>
            Удалить
          </Button>
        </Stack>
      </Stack>

      {detectResult && (
        <Alert severity="info" sx={{ mt: 2 }} onClose={() => setDetectResult(null)}>
          {detectResult.map((r) =>
            r.found
              ? `${protocolLabels[r.protocol]}: найдена установка, импортировано peers: ${r.importedCount}. `
              : `${protocolLabels[r.protocol]}: не найдено. `,
          )}
        </Alert>
      )}

      {server.needsCredentials && (
        <Alert
          severity="warning"
          sx={{ mt: 2 }}
          action={
            !isEditingCredentials && (
              <Button color="inherit" size="small" onClick={() => setIsEditingCredentials(true)}>
                Ввести заново
              </Button>
            )
          }
        >
          Сохранённый SSH-пароль/ключ не расшифровывается текущим ключом шифрования панели
          (обычно после восстановления БД на другом сервере) — введите учётные данные заново,
          чтобы снова управлять этим сервером.
        </Alert>
      )}
      {isEditingCredentials && (
        <Stack direction="row" spacing={2} alignItems="flex-start" mt={2}>
          <TextField
            select
            size="small"
            label="Тип авторизации"
            value={credAuthType}
            onChange={(e) => setCredAuthType(e.target.value as SshAuthType)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="password">Пароль</MenuItem>
            <MenuItem value="private_key">Приватный ключ</MenuItem>
          </TextField>
          <TextField
            size="small"
            label={credAuthType === 'password' ? 'Пароль' : 'Приватный ключ (PEM)'}
            type={credAuthType === 'password' ? 'password' : 'text'}
            multiline={credAuthType === 'private_key'}
            value={credSecret}
            onChange={(e) => setCredSecret(e.target.value)}
            sx={{ minWidth: 240 }}
          />
          <Button
            size="small"
            variant="contained"
            disabled={!credSecret || credentialsSaving}
            onClick={() => {
              onUpdateCredentials({ sshAuthType: credAuthType, secret: credSecret });
              setIsEditingCredentials(false);
              setCredSecret('');
            }}
          >
            Сохранить
          </Button>
          <Button size="small" onClick={() => setIsEditingCredentials(false)}>
            Отмена
          </Button>
        </Stack>
      )}
      {credentialsError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {credentialsError}
        </Alert>
      )}

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" mb={1}>
        Протоколы
      </Typography>
      <Stack spacing={1}>
        {server.protocols.map((sp) => (
          <Box key={sp.id}>
            <Stack direction="row" spacing={2} alignItems="center">
              <Chip label={sp.protocol} size="small" />
              <Chip label={sp.status} size="small" color={statusColor[sp.status]} />
              <Typography variant="body2">
                порт {sp.listenPort}, сеть {sp.networkCidr}
              </Typography>
              {sp.bridgeName && <Chip label={`мост «${sp.bridgeName}»`} size="small" color="info" variant="outlined" />}
              {sp.lastError && (
                <Typography variant="body2" color="error">
                  {sp.lastError}
                </Typography>
              )}
              {sp.status === 'active' && (
                <Button size="small" onClick={() => onScan(sp.id)}>
                  Сканировать/импортировать peers
                </Button>
              )}
            </Stack>
            {sp.status === 'installing' && <LinearProgress sx={{ mt: 1 }} />}
          </Box>
        ))}
        {server.protocols.length === 0 && <Typography variant="body2">Протоколы ещё не устанавливались</Typography>}
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" mb={1}>
        Установить протокол
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={1}>
        Если на сервере уже может быть настроен VPN — сначала нажмите «Проверить
        существующую установку» выше, иначе установка пересоздаст интерфейс с новыми
        ключами и существующие peers будут потеряны.
      </Typography>
      <Stack direction="row" spacing={2} alignItems="flex-start">
        <TextField select label="Протокол" value={protocol} onChange={(e) => setProtocol(e.target.value as VpnProtocol)} sx={{ minWidth: 160 }}>
          <MenuItem value="wireguard">WireGuard</MenuItem>
          <MenuItem value="amneziawg">AmneziaWG</MenuItem>
        </TextField>
        <TextField
          label="Порт"
          type="number"
          value={listenPort}
          onChange={(e) => setListenPort(Number(e.target.value))}
          sx={{ width: 120 }}
        />
        <TextField label="Сеть (CIDR)" value={networkCidr} onChange={(e) => setNetworkCidr(e.target.value)} sx={{ width: 160 }} />
        <Button
          variant="outlined"
          disabled={isInstalling}
          startIcon={isInstalling ? <CircularProgress size={16} /> : undefined}
          onClick={() => onInstall(protocol, listenPort, networkCidr)}
        >
          {isInstalling ? 'Установка...' : 'Установить'}
        </Button>
      </Stack>
      {isInstalling && (
        <Typography variant="body2" color="text.secondary" mt={1}>
          Идёт установка по SSH — может занять несколько минут (особенно AmneziaWG, ставится из PPA). Статус
          протокола обновляется автоматически.
        </Typography>
      )}
      {installError && !isInstalling && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {installError}
        </Alert>
      )}
    </Paper>
  );
}
