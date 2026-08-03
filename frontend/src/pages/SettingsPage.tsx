import { Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Paper, Stack, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { downloadDatabaseBackup, fetchVersion, triggerUpdate } from '../api/system';

export function SettingsPage() {
  const { data: version, isLoading, refetch, isFetching } = useQuery({ queryKey: ['system', 'version'], queryFn: fetchVersion });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

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
        <Stack direction="row" spacing={2} mt={2}>
          <Button onClick={() => refetch()} disabled={isFetching}>
            Проверить
          </Button>
          <Button variant="contained" color="warning" onClick={() => setConfirmOpen(true)}>
            Обновить
          </Button>
        </Stack>
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
