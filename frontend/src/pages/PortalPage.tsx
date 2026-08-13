import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getErrorMessage } from '../api/errors';
import {
  downloadPortalConfig,
  fetchPortalStatus,
  fetchPortalUpstreamOptions,
  issuePortalConfig,
  PortalUpstreamOption,
  registerPortal,
} from '../api/telegramPortal';
import { PeerDeviceType, VpnProtocol } from '../api/types';

const deviceLabels: Record<PeerDeviceType, string> = { phone: 'Телефон', pc: 'ПК' };
const statusLabels: Record<string, string> = { pending: 'Ожидает подтверждения', approved: 'Подтверждён' };

function downloadConfigFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Публичная страница без DashboardLayout/JwtAuthGuard — доступ по персональному токену в
// URL (см. TelegramPortalService на бэкенде). Два режима в одном компоненте: без токена в
// адресе — форма регистрации (совпадает с диалогом бота: организация/ИНН → ФИО), с
// токеном — статус заявки и выдача/перевыпуск конфигов, для клиентов без доступа к Telegram.
export function PortalPage() {
  const { token } = useParams<{ token?: string }>();
  return token ? <PortalStatusView token={token} /> : <PortalRegisterView />;
}

function PortalShell({ children, maxWidth = 420 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <Box display="flex" alignItems="center" justifyContent="center" minHeight="100vh" bgcolor="grey.100" px={2} py={4}>
      <Paper sx={{ p: { xs: 3, sm: 4 }, width: '100%', maxWidth }} elevation={3}>
        <Typography variant="h5" mb={3} textAlign="center">
          Доступ к VPN
        </Typography>
        {children}
      </Paper>
    </Box>
  );
}

function PortalRegisterView() {
  const navigate = useNavigate();
  const [orgQuery, setOrgQuery] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const registerMutation = useMutation({
    mutationFn: () => registerPortal(orgQuery, fullName),
    onSuccess: ({ webToken }) => navigate(`/portal/${webToken}`, { replace: true }),
    onError: (err) => setError(getErrorMessage(err, 'Не удалось зарегистрироваться')),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    registerMutation.mutate();
  }

  return (
    <PortalShell>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Заполните форму, чтобы запросить доступ к VPN. После подтверждения администратором вы
        сможете скачать конфиги на этой же странице — сохраните её ссылку.
      </Typography>
      <form onSubmit={handleSubmit}>
        <TextField
          label="Название организации или её ИНН"
          fullWidth
          margin="normal"
          value={orgQuery}
          onChange={(e) => setOrgQuery(e.target.value)}
          required
        />
        <TextField
          label="Фамилия, имя, отчество"
          fullWidth
          margin="normal"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        <Button type="submit" variant="contained" fullWidth sx={{ mt: 3 }} disabled={registerMutation.isPending}>
          Зарегистрироваться
        </Button>
      </form>
    </PortalShell>
  );
}

interface IssueDialogState {
  deviceType: PeerDeviceType;
  isReissue: boolean;
  protocol: VpnProtocol;
  upstreamKey?: string;
}

function PortalStatusView({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ['portal-status', token], queryFn: () => fetchPortalStatus(token) });
  const [issueDialog, setIssueDialog] = useState<IssueDialogState | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [result, setResult] = useState<{ filename: string; content: string; qrDataUri: string } | null>(null);

  const downloadMutation = useMutation({
    mutationFn: (deviceType: PeerDeviceType) => downloadPortalConfig(token, deviceType),
    onSuccess: (data) => {
      setResult(data);
      setDownloadError(null);
    },
    onError: (err) => setDownloadError(getErrorMessage(err, 'Не удалось скачать конфиг')),
  });

  const upstreamOptionsQuery = useQuery({
    queryKey: ['portal-upstream-options', token, issueDialog?.protocol],
    queryFn: () => fetchPortalUpstreamOptions(token, issueDialog!.protocol),
    enabled: !!issueDialog,
  });

  const issueMutation = useMutation({
    mutationFn: () =>
      issuePortalConfig(token, {
        deviceType: issueDialog!.deviceType,
        protocol: issueDialog!.protocol,
        upstreamKey: issueDialog!.upstreamKey,
      }),
    onSuccess: (data) => {
      setResult(data);
      setIssueDialog(null);
      setIssueError(null);
      queryClient.invalidateQueries({ queryKey: ['portal-status', token] });
    },
    onError: (err) => setIssueError(getErrorMessage(err, 'Не удалось получить конфиг')),
  });

  if (statusQuery.isLoading) {
    return (
      <PortalShell>
        <Typography textAlign="center">Загрузка…</Typography>
      </PortalShell>
    );
  }

  if (statusQuery.isError) {
    return (
      <PortalShell>
        <Alert severity="error">{getErrorMessage(statusQuery.error, 'Ссылка недействительна')}</Alert>
      </PortalShell>
    );
  }

  const status = statusQuery.data!;
  const options = upstreamOptionsQuery.data ?? [];
  const needsUpstreamChoice = options.length > 1;

  return (
    <PortalShell maxWidth={520}>
      <Stack spacing={0.5} mb={2}>
        <Typography variant="body1">{status.fullName}</Typography>
        <Typography variant="body2" color="text.secondary">
          {status.organizationName}
        </Typography>
        <Chip
          size="small"
          sx={{ alignSelf: 'flex-start', mt: 1 }}
          label={statusLabels[status.status] ?? status.status}
          color={status.status === 'approved' ? 'success' : 'warning'}
        />
      </Stack>

      {status.status !== 'approved' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Заявка ещё не подтверждена администратором. Обновите страницу позже — конфиги
          появятся здесь сразу после подтверждения.
        </Alert>
      )}

      {status.botDeepLink && (
        <Button href={status.botDeepLink} target="_blank" rel="noopener" variant="outlined" fullWidth sx={{ mb: 2 }}>
          {status.linkedToTelegram ? 'Открыть бота в Telegram' : 'Привязать Telegram (необязательно)'}
        </Button>
      )}

      {status.status === 'approved' && (
        <Stack spacing={2}>
          {(['phone', 'pc'] as PeerDeviceType[]).map((deviceType) => {
            const device = status.devices.find((d) => d.deviceType === deviceType);
            return (
              <Paper key={deviceType} variant="outlined" sx={{ p: 1.5 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" rowGap={1}>
                  <Box>
                    <Typography variant="subtitle2">{deviceLabels[deviceType]}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {device ? `Выдан: ${new Date(device.createdAt).toLocaleString()}` : 'Ещё не выдан'}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    {device && (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={downloadMutation.isPending}
                        onClick={() => {
                          setDownloadError(null);
                          downloadMutation.mutate(deviceType);
                        }}
                      >
                        Скачать
                      </Button>
                    )}
                    <Button
                      size="small"
                      variant={device ? 'outlined' : 'contained'}
                      onClick={() => {
                        setIssueError(null);
                        setIssueDialog({ deviceType, isReissue: !!device, protocol: 'amneziawg' });
                      }}
                    >
                      {device ? 'Перевыпустить' : 'Получить'}
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            );
          })}
          {downloadError && <Alert severity="error">{downloadError}</Alert>}
        </Stack>
      )}

      {result && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
          <Typography variant="subtitle2" mb={1}>
            Конфиг «{result.filename}» готов
          </Typography>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Сохраните файл сейчас — при следующем перевыпуске этот конфиг перестанет работать.
          </Alert>
          <Stack spacing={2} alignItems="center">
            <Box component="img" src={result.qrDataUri} alt="QR-код" sx={{ width: 200, height: 200 }} />
            <Button variant="contained" onClick={() => downloadConfigFile(result.filename, result.content)}>
              Скачать .conf
            </Button>
          </Stack>
        </Paper>
      )}

      <Dialog open={!!issueDialog} onClose={() => setIssueDialog(null)} fullWidth maxWidth="xs">
        <DialogTitle>{issueDialog && deviceLabels[issueDialog.deviceType]}: выбор протокола</DialogTitle>
        <DialogContent>
          {issueDialog?.isReissue && (
            <DialogContentText sx={{ mb: 2 }}>
              У вас уже есть конфиг для этого устройства. При перевыпуске старый перестанет
              работать.
            </DialogContentText>
          )}
          <TextField
            select
            label="Протокол"
            fullWidth
            margin="dense"
            value={issueDialog?.protocol ?? 'amneziawg'}
            onChange={(e) => setIssueDialog((prev) => (prev ? { ...prev, protocol: e.target.value as VpnProtocol, upstreamKey: undefined } : prev))}
          >
            <MenuItem value="amneziawg">AmneziaWG</MenuItem>
            <MenuItem value="wireguard">WireGuard</MenuItem>
          </TextField>
          {needsUpstreamChoice && (
            <TextField
              select
              label="Сервер"
              fullWidth
              margin="dense"
              value={issueDialog?.upstreamKey ?? ''}
              onChange={(e) => setIssueDialog((prev) => (prev ? { ...prev, upstreamKey: e.target.value } : prev))}
            >
              {options.map((option: PortalUpstreamOption) => (
                <MenuItem key={option.key} value={option.key}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
          )}
          {!upstreamOptionsQuery.isLoading && options.length === 0 && (
            <Alert severity="error" sx={{ mt: 1 }}>
              Для вашей организации не настроен доступ ни к одному серверу.
            </Alert>
          )}
          {issueError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {issueError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIssueDialog(null)}>Отмена</Button>
          <Button
            variant="contained"
            disabled={
              issueMutation.isPending ||
              options.length === 0 ||
              (needsUpstreamChoice && !issueDialog?.upstreamKey)
            }
            onClick={() => issueMutation.mutate()}
          >
            {issueDialog?.isReissue ? 'Перевыпустить' : 'Получить'}
          </Button>
        </DialogActions>
      </Dialog>
    </PortalShell>
  );
}
