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
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import NetworkCheckIcon from '@mui/icons-material/NetworkCheck';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SecurityIcon from '@mui/icons-material/Security';
import SyncIcon from '@mui/icons-material/Sync';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import TerminalIcon from '@mui/icons-material/Terminal';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import VpnLockIcon from '@mui/icons-material/VpnLock';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { connectDashboardSocket } from '../api/dashboard';
import { getErrorMessage } from '../api/errors';
import { TerminalDialog } from '../components/TerminalDialog';
import {
  CreateServerInput,
  DetectionResult,
  Fail2banStatus,
  UpdateServerCredentialsInput,
  checkProtocolVersion,
  createServer,
  deleteProtocol,
  deleteServer,
  detectExistingInstallations,
  ensureFail2ban,
  fetchMtProxyStatus,
  fetchServers,
  installMtProxy,
  installProtocol,
  rebootServer,
  resetHostKeyFingerprint,
  scanAndImportPeers,
  testServerConnection,
  updateProtocolPackage,
  updateServer,
  updateServerCredentials,
} from '../api/servers';
import { ServerEntity, ServerProtocolEntity, SshAuthType, VpnProtocol } from '../api/types';

// Порт/сеть по умолчанию в форме установки одинаковы для любого протокола — если на
// сервере уже что-то активно занимает их (например, AmneziaWG уже установлен на 51820/
// 10.8.0.0/24), подставлять их же для второго протокола бессмысленно: установка упадёт с
// "Address already in use" на SSH-уровне (бэкенд теперь тоже отдельно это проверяет и
// отклоняет ДО SSH — см. VpnProvisioningService.installProtocol — это только про удобный
// дефолт в форме, не про саму защиту от конфликта).
function suggestPort(existing: ServerProtocolEntity[], base = 51820): number {
  const used = new Set(existing.filter((sp) => sp.status !== 'error').map((sp) => sp.listenPort));
  let port = base;
  while (used.has(port)) {
    port += 1;
  }
  return port;
}

function suggestNetworkCidr(existing: ServerProtocolEntity[], base = '10.8.0.0/24'): string {
  const used = new Set(existing.filter((sp) => sp.status !== 'error').map((sp) => sp.networkCidr));
  const match = base.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/);
  if (!match) {
    return base;
  }
  let thirdOctet = Number(match[3]);
  let candidate = base;
  while (used.has(candidate)) {
    thirdOctet += 1;
    candidate = `${match[1]}.${match[2]}.${thirdOctet}.0/24`;
  }
  return candidate;
}

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
    // Всегда поллим (не только пока что-то устанавливается) — иначе результат "Проверить
    // подключение"/"Обновить пакет"/"Проверить версию" (идут по SSH синхронно на бэкенде,
    // секунды-минуты) не появляется на странице, пока её не перезагрузить руками. Пока
    // что-то в процессе установки — чаще, это самое "живое" состояние.
    refetchInterval: (query) => {
      const data = query.state.data as ServerEntity[] | undefined;
      const hasInstalling = data?.some((server) => server.protocols.some((sp) => sp.status === 'installing'));
      return hasInstalling ? 3000 : 8000;
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
    mutationFn: (vars: { id: string; name: string; maxPeers: number; amneziaAppName: string | null }) =>
      updateServer(vars.id, { name: vars.name, maxPeers: vars.maxPeers, amneziaAppName: vars.amneziaAppName }),
    onSuccess: invalidate,
  });
  const fail2banMutation = useMutation({ mutationFn: ensureFail2ban });
  const resetHostKeyMutation = useMutation({ mutationFn: resetHostKeyFingerprint, onSuccess: invalidate });
  const testMutation = useMutation({ mutationFn: testServerConnection, onSuccess: invalidate });
  const credentialsMutation = useMutation({
    mutationFn: (vars: { id: string; input: UpdateServerCredentialsInput }) => updateServerCredentials(vars.id, vars.input),
    onSuccess: invalidate,
  });
  const installMutation = useMutation({
    // Только {protocol, listenPort, networkCidr} в теле запроса — InstallProtocolDto не
    // объявляет serverId (он и так уже в URL, /servers/:id/protocols), а глобальный
    // ValidationPipe с forbidNonWhitelisted:true отклоняет лишние поля.
    mutationFn: (vars: { serverId: string; protocol: VpnProtocol; listenPort: number; networkCidr: string }) =>
      installProtocol(vars.serverId, { protocol: vars.protocol, listenPort: vars.listenPort, networkCidr: vars.networkCidr }),
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
          мостом — видно по чипу "мост «Имя»" у самого протокола ниже. Сетка вместо
          вертикального списка — auto-fill сам решает, сколько карточек влезает в ряд
          (обычно 2-3 на десктопе), пересчитывая при изменении ширины окна. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))', gap: 2 }}>
        {servers?.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            online={onlineByServer[server.id]}
            onDelete={() => deleteMutation.mutate(server.id)}
            onRename={(name, maxPeers, amneziaAppName) => renameMutation.mutate({ id: server.id, name, maxPeers, amneziaAppName })}
            onTest={() => testMutation.mutate(server.id)}
            onEnsureFail2ban={() => fail2banMutation.mutate(server.id)}
            fail2banPending={fail2banMutation.isPending && fail2banMutation.variables === server.id}
            fail2banResult={fail2banMutation.variables === server.id ? fail2banMutation.data : undefined}
            fail2banErrorMessage={
              fail2banMutation.isError && fail2banMutation.variables === server.id
                ? getErrorMessage(fail2banMutation.error, 'Не удалось настроить fail2ban')
                : undefined
            }
            onResetHostKey={() => resetHostKeyMutation.mutate(server.id)}
            resetHostKeyPending={resetHostKeyMutation.isPending && resetHostKeyMutation.variables === server.id}
            isTesting={testMutation.isPending && testMutation.variables === server.id}
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
      </Box>

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
  isTesting,
  onReboot,
  onInstall,
  isInstalling,
  installError,
  onScan,
  onDetected,
  onUpdateCredentials,
  credentialsSaving,
  credentialsError,
  onEnsureFail2ban,
  fail2banPending,
  fail2banResult,
  fail2banErrorMessage,
  onResetHostKey,
  resetHostKeyPending,
}: {
  server: ServerEntity;
  online?: boolean;
  onDelete: () => void;
  onRename: (name: string, maxPeers: number, amneziaAppName: string | null) => void;
  onTest: () => void;
  isTesting: boolean;
  onReboot: () => void;
  onInstall: (protocol: VpnProtocol, listenPort: number, networkCidr: string) => void;
  isInstalling: boolean;
  installError: string | null;
  onScan: (serverProtocolId: string) => void;
  onDetected: () => void;
  onUpdateCredentials: (input: UpdateServerCredentialsInput) => void;
  credentialsSaving: boolean;
  credentialsError: string | null;
  onEnsureFail2ban: () => void;
  fail2banPending: boolean;
  fail2banResult: Fail2banStatus | undefined;
  fail2banErrorMessage: string | undefined;
  onResetHostKey: () => void;
  resetHostKeyPending: boolean;
}) {
  const [protocol, setProtocol] = useState<VpnProtocol>('wireguard');
  const [listenPort, setListenPort] = useState(() => suggestPort(server.protocols));
  const [networkCidr, setNetworkCidr] = useState(() => suggestNetworkCidr(server.protocols));
  const [detectResult, setDetectResult] = useState<DetectionResult[] | null>(null);

  // Если список протоколов сервера изменился (например, только что установили первый
  // протокол) и текущее значение в форме теперь реально с чем-то конфликтует — молча
  // подставляем свободный порт/сеть. Не трогаем поля, если конфликта нет (не затираем
  // осознанный ручной выбор администратора).
  useEffect(() => {
    if (server.protocols.some((sp) => sp.status === 'active' && sp.listenPort === listenPort)) {
      setListenPort(suggestPort(server.protocols));
    }
    if (server.protocols.some((sp) => sp.status === 'active' && sp.networkCidr === networkCidr)) {
      setNetworkCidr(suggestNetworkCidr(server.protocols));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.protocols]);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(server.name);
  const [editMaxPeers, setEditMaxPeers] = useState(server.maxPeers);
  const [editAmneziaAppName, setEditAmneziaAppName] = useState(server.amneziaAppName ?? '');
  const [isEditingCredentials, setIsEditingCredentials] = useState(false);
  const [credAuthType, setCredAuthType] = useState<SshAuthType>('password');
  const [credSecret, setCredSecret] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);

  const detectMutation = useMutation({
    mutationFn: () => detectExistingInstallations(server.id),
    onSuccess: (data) => {
      setDetectResult(data);
      onDetected();
    },
  });

  const deleteProtocolMutation = useMutation({ mutationFn: deleteProtocol, onSuccess: onDetected });
  const checkVersionMutation = useMutation({ mutationFn: checkProtocolVersion, onSuccess: onDetected });
  const updatePackageMutation = useMutation({ mutationFn: updateProtocolPackage, onSuccess: onDetected });

  // Постоянный MTProto-proxy (обход блокировки Telegram) — только на self-сервере, см.
  // README/MtProxyService. GET отдельно от установки — чтобы посмотреть уже выданную ссылку
  // без переустановки (переустановка меняет порт+ключ и рвёт уже разосланные ссылки).
  const mtProxyStatusQuery = useQuery({
    queryKey: ['mtproxy-status', server.id],
    queryFn: () => fetchMtProxyStatus(server.id),
    enabled: server.isSelf,
  });
  const mtProxyInstallMutation = useMutation({
    mutationFn: () => installMtProxy(server.id),
    onSuccess: () => mtProxyStatusQuery.refetch(),
  });

  const protocolLabels: Record<VpnProtocol, string> = { wireguard: 'WireGuard', amneziawg: 'AmneziaWG' };

  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Box>
          {isEditingName ? (
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap mb={1}>
              <TextField size="small" label="Название" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
              <TextField
                size="small"
                label="Лимит peers"
                type="number"
                value={editMaxPeers}
                onChange={(e) => setEditMaxPeers(Number(e.target.value))}
                sx={{ width: 120 }}
              />
              <TextField
                size="small"
                label="Имя в приложении AmneziaVPN"
                value={editAmneziaAppName}
                onChange={(e) => setEditAmneziaAppName(e.target.value)}
                placeholder={server.name}
                helperText="Пусто — используется название сервера"
                sx={{ width: 260 }}
              />
              <Tooltip title="Сохранить">
                <IconButton
                  size="small"
                  color="primary"
                  onClick={() => {
                    onRename(editName, editMaxPeers, editAmneziaAppName.trim() || null);
                    setIsEditingName(false);
                  }}
                >
                  <CheckIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Отмена">
                <IconButton
                  size="small"
                  onClick={() => {
                    setEditAmneziaAppName(server.amneziaAppName ?? '');
                    setIsEditingName(false);
                  }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ) : (
            <Typography variant="h6" sx={{ wordBreak: 'break-word' }}>
              {server.name}
            </Typography>
          )}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap rowGap={0.5} sx={{ my: 0.5 }}>
            <Chip size="small" label={server.status} color={statusColor[server.status]} />
            {server.isSelf && <Chip size="small" label="Мост (self)" color="info" />}
            <Chip
              size="small"
              label={online === undefined ? 'проверяем связь…' : online ? 'на связи' : 'нет связи'}
              color={online === undefined ? 'default' : online ? 'success' : 'error'}
              variant="outlined"
            />
            {server.needsCredentials && <Chip size="small" label="нужны новые SSH-данные" color="warning" />}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
            {server.sshUsername}@{server.host}:{server.sshPort} · лимит {server.maxPeers} peers
          </Typography>
          {server.lastError && (
            <Typography variant="body2" color="error">
              {server.lastError}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          <Tooltip title={isTesting ? 'Проверяем…' : 'Проверить подключение'}>
            <span>
              <IconButton size="small" onClick={onTest} disabled={isTesting}>
                {isTesting ? <CircularProgress size={16} /> : <NetworkCheckIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Проверить существующую установку">
            <IconButton size="small" onClick={() => detectMutation.mutate()} disabled={detectMutation.isPending}>
              <TravelExploreIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Перезагрузить">
            <IconButton size="small" color="warning" onClick={onReboot}>
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={fail2banPending ? 'Проверяем/устанавливаем…' : 'Проверить и установить fail2ban'}>
            <span>
              <IconButton size="small" onClick={onEnsureFail2ban} disabled={fail2banPending}>
                {fail2banPending ? <CircularProgress size={16} /> : <SecurityIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip
            title={
              resetHostKeyPending
                ? 'Сбрасываем…'
                : server.sshHostKeyFingerprint
                  ? `SSH-ключ хоста закреплён (${server.sshHostKeyFingerprint}). Нажмите, чтобы сбросить после переустановки сервера — иначе следующее подключение будет отклонено как возможная подмена.`
                  : 'SSH-ключ хоста ещё не закреплён — закрепится при следующем подключении'
            }
          >
            <span>
              <IconButton size="small" onClick={onResetHostKey} disabled={resetHostKeyPending || !server.sshHostKeyFingerprint}>
                {resetHostKeyPending ? <CircularProgress size={16} /> : <VpnKeyIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
          {server.isSelf && (
            <Tooltip
              title={
                mtProxyInstallMutation.isPending
                  ? 'Устанавливаем…'
                  : server.mtProxyPort
                    ? 'Переустановить MTProto-proxy (обход блокировки Telegram) — новые порт и ключ, старая ссылка перестанет работать'
                    : 'Установить MTProto-proxy (обход блокировки Telegram) — ссылка показывается клиентам на портале регистрации'
              }
            >
              <span>
                <IconButton size="small" onClick={() => mtProxyInstallMutation.mutate()} disabled={mtProxyInstallMutation.isPending}>
                  {mtProxyInstallMutation.isPending ? <CircularProgress size={16} /> : <VpnLockIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          )}
          {!isEditingName && (
            <Tooltip title="Переименовать">
              <IconButton
                size="small"
                onClick={() => {
                  setEditName(server.name);
                  setEditMaxPeers(server.maxPeers);
                  setEditAmneziaAppName(server.amneziaAppName ?? '');
                  setIsEditingName(true);
                }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Терминал">
            <IconButton size="small" onClick={() => setTerminalOpen(true)}>
              <TerminalIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Удалить сервер">
            <IconButton size="small" color="error" onClick={onDelete}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {terminalOpen && (
        <TerminalDialog serverId={server.id} serverLabel={`${server.name} (${server.host})`} onClose={() => setTerminalOpen(false)} />
      )}

      {detectResult && (
        <Alert severity="info" sx={{ mt: 2 }} onClose={() => setDetectResult(null)}>
          {detectResult.map((r) =>
            r.found
              ? `${protocolLabels[r.protocol]}: найдена установка, импортировано peers: ${r.importedCount}. `
              : `${protocolLabels[r.protocol]}: не найдено. `,
          )}
        </Alert>
      )}

      {fail2banResult && !fail2banPending && (
        <Alert severity={fail2banResult.installed ? 'success' : 'warning'} sx={{ mt: 2 }}>
          {fail2banResult.installed
            ? `fail2ban установлен, забанено IP: ${fail2banResult.bannedCount}`
            : 'Не удалось подтвердить установку fail2ban на сервере'}
        </Alert>
      )}
      {fail2banErrorMessage && !fail2banPending && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {fail2banErrorMessage}
        </Alert>
      )}

      {server.isSelf && mtProxyStatusQuery.data?.installed && (
        <Alert severity="success" sx={{ mt: 2 }}>
          <Typography variant="body2">
            MTProto-proxy на порту {mtProxyStatusQuery.data.port} — эта ссылка автоматически показывается клиентам на
            портале регистрации для обхода блокировки Telegram. Ключ обновляется автоматически раз в сутки.
          </Typography>
          <Typography variant="caption" sx={{ wordBreak: 'break-all', display: 'block', mt: 0.5 }}>
            {mtProxyStatusQuery.data.deepLink}
          </Typography>
        </Alert>
      )}
      {mtProxyInstallMutation.isError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {getErrorMessage(mtProxyInstallMutation.error, 'Не удалось установить mtproxy')}
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
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap rowGap={1.5} alignItems="flex-start" mt={2}>
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
          <Box key={sp.id} sx={{ py: 0.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap rowGap={0.5}>
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap rowGap={0.5}>
                <Chip label={sp.protocol} size="small" />
                <Chip label={sp.status} size="small" color={statusColor[sp.status]} />
                <Typography variant="body2" color="text.secondary">
                  :{sp.listenPort} · {sp.networkCidr}
                </Typography>
                {sp.bridgeName && <Chip label={`мост «${sp.bridgeName}»`} size="small" color="info" variant="outlined" />}
              </Stack>
              <Stack direction="row" spacing={0.25}>
                {sp.status === 'active' && (
                  <Tooltip title="Сканировать/импортировать peers">
                    <IconButton size="small" onClick={() => onScan(sp.id)}>
                      <SyncIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                {sp.status === 'active' && !sp.execContainer && (
                  <>
                    <Tooltip title="Проверить версию">
                      <IconButton
                        size="small"
                        disabled={checkVersionMutation.isPending && checkVersionMutation.variables === sp.id}
                        onClick={() => checkVersionMutation.mutate(sp.id)}
                      >
                        <RefreshIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Обновить пакет">
                      <IconButton
                        size="small"
                        disabled={updatePackageMutation.isPending && updatePackageMutation.variables === sp.id}
                        onClick={() => updatePackageMutation.mutate(sp.id)}
                      >
                        <SystemUpdateAltIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </>
                )}
                {!sp.bridgeName && (
                  <Tooltip title="Удалить протокол">
                    <IconButton
                      size="small"
                      color="error"
                      disabled={deleteProtocolMutation.isPending && deleteProtocolMutation.variables === sp.id}
                      onClick={() => deleteProtocolMutation.mutate(sp.id)}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            </Stack>
            {sp.status === 'active' && (
              <Typography variant="caption" color="text.secondary" display="block">
                {sp.packageVersion ?? 'версия не проверялась'}
              </Typography>
            )}
            {sp.lastError && (
              <Typography variant="body2" color="error" sx={{ wordBreak: 'break-word' }}>
                {sp.lastError}
              </Typography>
            )}
            {sp.status === 'installing' && <LinearProgress sx={{ mt: 1 }} />}
            {checkVersionMutation.isError && checkVersionMutation.variables === sp.id && (
              <Typography variant="body2" color="error">
                {getErrorMessage(checkVersionMutation.error, 'Не удалось проверить версию')}
              </Typography>
            )}
            {updatePackageMutation.isError && updatePackageMutation.variables === sp.id && (
              <Typography variant="body2" color="error">
                {getErrorMessage(updatePackageMutation.error, 'Не удалось обновить пакет')}
              </Typography>
            )}
            {deleteProtocolMutation.isError && deleteProtocolMutation.variables === sp.id && (
              <Typography variant="body2" color="error">
                {getErrorMessage(deleteProtocolMutation.error, 'Не удалось удалить протокол')}
              </Typography>
            )}
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
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap rowGap={1.5} alignItems="flex-start">
        <TextField
          select
          size="small"
          label="Протокол"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as VpnProtocol)}
          sx={{ width: 140 }}
        >
          <MenuItem value="wireguard">WireGuard</MenuItem>
          <MenuItem value="amneziawg">AmneziaWG</MenuItem>
        </TextField>
        <TextField
          label="Порт"
          type="number"
          size="small"
          value={listenPort}
          onChange={(e) => setListenPort(Number(e.target.value))}
          sx={{ width: 100 }}
        />
        <TextField
          label="Сеть (CIDR)"
          size="small"
          value={networkCidr}
          onChange={(e) => setNetworkCidr(e.target.value)}
          sx={{ width: 150 }}
        />
        <Button
          variant="outlined"
          size="small"
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
