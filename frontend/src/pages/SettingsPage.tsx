import {
  Alert,
  Button,
  Chip,
  CircularProgress,
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
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import {
  connectUpdateProgressSocket,
  downloadDatabaseBackup,
  downloadLogs,
  fetchLogs,
  fetchVersion,
  LogService,
  triggerUpdate,
  UpdateProgress,
} from '../api/system';

export function SettingsPage() {
  const { data: version, isLoading, refetch, isFetching } = useQuery({ queryKey: ['system', 'version'], queryFn: fetchVersion });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [waitingForBackend, setWaitingForBackend] = useState(false);

  // Прогресс приходит по WebSocket независимо от того, кто именно нажал "Обновить" —
  // так и должно быть, все суперадмины видят одно и то же состояние обновления.
  // Последний шаг (пересоздание backend) неизбежно рвёт это же соединение — это НЕ
  // ошибка: socket.io переподключается сам, а мы трактуем реконнект после активного
  // обновления как его завершение.
  useEffect(() => {
    let isFirstConnect = true;
    const socket = connectUpdateProgressSocket((p) => {
      setProgress(p);
      setWaitingForBackend(false);
      if (p.done) {
        refetch();
        setTimeout(() => setProgress(null), 2500);
      }
    });
    socket.on('connect', () => {
      if (!isFirstConnect) {
        setWaitingForBackend(false);
        setProgress((prev) => (prev && !prev.done ? { percent: 100, step: 'Готово', done: true } : prev));
        refetch();
        setTimeout(() => setProgress(null), 2500);
      }
      isFirstConnect = false;
    });
    socket.on('disconnect', () => {
      setProgress((prev) => {
        if (prev && !prev.done) {
          setWaitingForBackend(true);
        }
        return prev;
      });
    });
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateMutation = useMutation({
    mutationFn: triggerUpdate,
    onSuccess: (data) => {
      setUpdateMessage(data.message);
      setUpdateError(null);
      setConfirmOpen(false);
    },
    onError: (err) => {
      setUpdateError(getErrorMessage(err, 'Не удалось запустить обновление'));
      setConfirmOpen(false);
    },
  });

  const backupMutation = useMutation({
    mutationFn: downloadDatabaseBackup,
    onError: (err) => setBackupError(getErrorMessage(err, 'Не удалось скачать бэкап')),
  });

  const [logService, setLogService] = useState<LogService>('backend');
  const [logTail, setLogTail] = useState(300);
  const [logError, setLogError] = useState<string | null>(null);
  const logsMutation = useMutation({
    mutationFn: () => fetchLogs(logService, logTail),
    onError: (err) => setLogError(getErrorMessage(err, 'Не удалось получить логи')),
  });
  const downloadLogsMutation = useMutation({
    mutationFn: () => downloadLogs(logService),
    onError: (err) => setLogError(getErrorMessage(err, 'Не удалось скачать логи')),
  });

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Настройки сервера</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Обновления
        </Typography>
        {isLoading && <Typography>Загрузка...</Typography>}
        {version && (
          <Stack spacing={1}>
            <Typography variant="body2">
              Текущая версия: <code>{version.currentCommitShort}</code>
            </Typography>
            <Typography variant="body2">
              Последняя на GitHub:{' '}
              {version.remoteCommitShort ? <code>{version.remoteCommitShort}</code> : 'не удалось проверить'}
            </Typography>
            {version.updateAvailable && <Chip color="warning" label="Доступно обновление" sx={{ width: 'fit-content' }} />}
            {!version.updateAvailable && version.remoteCommit && (
              <Chip color="success" label="Установлена последняя версия" sx={{ width: 'fit-content' }} />
            )}
          </Stack>
        )}
        {progress && !progress.done ? (
          <Stack direction="row" spacing={2} alignItems="center" mt={2}>
            <CircularProgress variant={waitingForBackend ? 'indeterminate' : 'determinate'} value={progress.percent} size={32} />
            <Typography variant="body2">
              {waitingForBackend ? 'Backend перезапускается, ждём восстановления соединения…' : `${progress.percent}% — ${progress.step}`}
            </Typography>
          </Stack>
        ) : (
          <Stack direction="row" spacing={2} mt={2}>
            <Button onClick={() => refetch()} disabled={isFetching}>
              Проверить
            </Button>
            <Button variant="contained" color="warning" onClick={() => setConfirmOpen(true)}>
              Обновить
            </Button>
          </Stack>
        )}
        {progress?.done && (
          <Alert severity={progress.error ? 'error' : 'success'} sx={{ mt: 2 }}>
            {progress.error ?? 'Обновление завершено'}
          </Alert>
        )}
        {updateMessage && (
          <Alert severity="info" sx={{ mt: 2 }}>
            {updateMessage}
          </Alert>
        )}
        {updateError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {updateError}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary" display="block" mt={2}>
          Если после обновления сайт перестал открываться — зайдите по SSH в каталог
          репозитория и выполните <code>docker compose up -d</code>: команда безопасна
          повторно запускать, она сама доведёт до консистентного состояния всё, что
          обновление не успело закончить.
        </Typography>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Резервная копия базы данных
        </Typography>
        <Button variant="outlined" disabled={backupMutation.isPending} onClick={() => backupMutation.mutate()}>
          Скачать бэкап (.sql)
        </Button>
        {backupError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {backupError}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Логи
        </Typography>
        <Stack direction="row" spacing={2} alignItems="flex-start" flexWrap="wrap" useFlexGap>
          <TextField select label="Сервис" size="small" value={logService} onChange={(e) => setLogService(e.target.value as LogService)} sx={{ minWidth: 140 }}>
            <MenuItem value="backend">backend</MenuItem>
            <MenuItem value="frontend">frontend</MenuItem>
            <MenuItem value="nginx">nginx</MenuItem>
            <MenuItem value="postgres">postgres</MenuItem>
          </TextField>
          <TextField
            label="Строк"
            type="number"
            size="small"
            value={logTail}
            onChange={(e) => setLogTail(Number(e.target.value))}
            sx={{ width: 110 }}
          />
          <Button variant="outlined" disabled={logsMutation.isPending} onClick={() => logsMutation.mutate()}>
            Показать
          </Button>
          <Button disabled={downloadLogsMutation.isPending} onClick={() => downloadLogsMutation.mutate()}>
            Скачать (.log)
          </Button>
        </Stack>
        {logError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {logError}
          </Alert>
        )}
        {logsMutation.data && (
          <Paper
            variant="outlined"
            sx={{
              mt: 2,
              p: 1.5,
              maxHeight: 480,
              overflow: 'auto',
              bgcolor: 'grey.900',
              color: 'grey.100',
            }}
          >
            <Typography component="pre" variant="caption" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace' }}>
              {logsMutation.data || 'Логов нет'}
            </Typography>
          </Paper>
        )}
      </Paper>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Обновить приложение?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Панель подтянет изменения из git и пересоберёт контейнеры (`docker compose up -d --build`).
            Приложение станет недоступно на время пересборки (обычно несколько минут). Активные VPN-подключения
            клиентов не затрагиваются — работают напрямую через серверы, независимо от панели.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Отмена</Button>
          <Button variant="contained" color="warning" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate()}>
            Обновить
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
