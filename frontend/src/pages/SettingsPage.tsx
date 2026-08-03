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
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { connectUpdateProgressSocket, downloadDatabaseBackup, fetchVersion, triggerUpdate, UpdateProgress } from '../api/system';

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
