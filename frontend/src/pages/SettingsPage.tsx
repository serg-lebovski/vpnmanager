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
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { fetchSettings, renewCertificate, updateSettings } from '../api/settings';
import {
  connectRestoreProgressSocket,
  connectUpdateProgressSocket,
  downloadDatabaseBackup,
  downloadLogs,
  fetchLogs,
  fetchVersion,
  LogService,
  restoreDatabase,
  triggerUpdate,
  UpdateProgress,
} from '../api/system';

// Должно совпадать с RESTORE_CONFIRMATION_PHRASE в backend/src/system/dto/restore-database.dto.ts.
const RESTORE_CONFIRMATION_PHRASE = 'ВОССТАНОВИТЬ';

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

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<UpdateProgress | null>(null);
  const [restoreWaitingForBackend, setRestoreWaitingForBackend] = useState(false);

  // Тот же "реконнект после активного действия = скорее всего готово" паттерн, что и у
  // прогресса обновления выше — RestoreService тоже намеренно рвёт это соединение в конце
  // (process.exit()).
  useEffect(() => {
    let isFirstConnect = true;
    const socket = connectRestoreProgressSocket((p) => {
      setRestoreProgress(p);
      setRestoreWaitingForBackend(false);
      if (p.done) {
        setTimeout(() => setRestoreProgress(null), 2500);
      }
    });
    socket.on('connect', () => {
      if (!isFirstConnect) {
        setRestoreWaitingForBackend(false);
        setRestoreProgress((prev) => (prev && !prev.done ? { percent: 100, step: 'Готово', done: true } : prev));
        setTimeout(() => setRestoreProgress(null), 2500);
      }
      isFirstConnect = false;
    });
    socket.on('disconnect', () => {
      setRestoreProgress((prev) => {
        if (prev && !prev.done) {
          setRestoreWaitingForBackend(true);
        }
        return prev;
      });
    });
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restoreMutation = useMutation({
    mutationFn: () => restoreDatabase(restoreFile!, restoreConfirmText),
    onSuccess: () => {
      setRestoreConfirmOpen(false);
      setRestoreError(null);
    },
    onError: (err) => setRestoreError(getErrorMessage(err, 'Не удалось запустить восстановление')),
  });

  const { data: settings, refetch: refetchSettings } = useQuery({ queryKey: ['system', 'settings'], queryFn: fetchSettings });
  const [domainInput, setDomainInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setDomainInput(settings.domain ?? '');
      setEmailInput(settings.letsEncryptEmail ?? '');
    }
  }, [settings]);

  const saveDomainMutation = useMutation({
    mutationFn: () => updateSettings({ domain: domainInput.trim(), letsEncryptEmail: emailInput.trim() }),
    onSuccess: () => {
      refetchSettings();
      setSettingsError(null);
    },
    onError: (err) => setSettingsError(getErrorMessage(err, 'Не удалось сохранить домен/email')),
  });
  const toggleHttpsMutation = useMutation({
    mutationFn: (httpsEnabled: boolean) => updateSettings({ httpsEnabled }),
    onSuccess: () => {
      refetchSettings();
      setSettingsError(null);
    },
    onError: (err) => setSettingsError(getErrorMessage(err, 'Не удалось изменить HTTPS')),
  });
  const toggleHttpMutation = useMutation({
    mutationFn: (httpEnabled: boolean) => updateSettings({ httpEnabled }),
    onSuccess: () => {
      refetchSettings();
      setSettingsError(null);
    },
    onError: (err) => setSettingsError(getErrorMessage(err, 'Не удалось изменить HTTP')),
  });
  const renewCertMutation = useMutation({
    mutationFn: () => renewCertificate(true),
    onSuccess: () => {
      refetchSettings();
      setSettingsError(null);
    },
    onError: (err) => setSettingsError(getErrorMessage(err, 'Не удалось обновить сертификат')),
  });
  const settingsBusy =
    saveDomainMutation.isPending || toggleHttpsMutation.isPending || toggleHttpMutation.isPending || renewCertMutation.isPending;

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
          Домен и HTTPS
        </Typography>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="flex-start">
          <TextField
            label="Домен"
            size="small"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            placeholder="example.com"
            sx={{ minWidth: 220 }}
          />
          <TextField
            label="Email для Let's Encrypt"
            size="small"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="admin@example.com"
            sx={{ minWidth: 220 }}
          />
          <Button variant="outlined" disabled={settingsBusy || !domainInput.trim()} onClick={() => saveDomainMutation.mutate()}>
            Сохранить
          </Button>
        </Stack>

        <Stack direction="row" spacing={3} alignItems="center" mt={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2">HTTP</Typography>
            <Switch
              checked={settings?.httpEnabled ?? true}
              disabled={settingsBusy}
              onChange={(e) => toggleHttpMutation.mutate(e.target.checked)}
            />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2">HTTPS</Typography>
            <Switch
              checked={settings?.httpsEnabled ?? false}
              disabled={settingsBusy || (!settings?.httpsEnabled && (!settings?.domain || !settings?.letsEncryptEmail))}
              onChange={(e) => toggleHttpsMutation.mutate(e.target.checked)}
            />
          </Stack>
          <Button
            size="small"
            disabled={settingsBusy || !settings?.httpsEnabled}
            onClick={() => renewCertMutation.mutate()}
          >
            Обновить сертификат сейчас
          </Button>
        </Stack>

        {settings?.certExpiresAt && (
          <Typography variant="body2" color="text.secondary" mt={1}>
            Сертификат действителен до: {new Date(settings.certExpiresAt).toLocaleString()}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" display="block" mt={1}>
          Порт 80 остаётся открытым даже при включённом HTTPS — он нужен для редиректа на
          HTTPS и для автообновления сертификата (Let's Encrypt проверяет домен именно по
          порту 80).
        </Typography>
        {settings?.lastCertError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {settings.lastCertError}
          </Alert>
        )}
        {settingsError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {settingsError}
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

        <Typography variant="subtitle1" mt={3} mb={1}>
          Восстановление из бэкапа
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>
          Полностью заменяет текущую базу данных содержимым загруженного файла —
          необратимо. Восстанавливает только данные (пиры, серверы, организации и т.д.), не
          сам проект — на новом сервере сначала разверните приложение обычным способом, а
          затем загрузите этот файл здесь. SSH-пароли/ключи серверов зашифрованы ключом
          ТЕКУЩЕГО деплоя — если он отличается от исходного (другой сервер), после
          восстановления серверы будут отмечены как требующие ввода пароля заново (страница
          «Серверы»).
        </Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <Button component="label" variant="outlined" disabled={!!(restoreProgress && !restoreProgress.done)}>
            Выбрать файл
            <input type="file" accept=".sql" hidden onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
          </Button>
          {restoreFile && <Typography variant="body2">{restoreFile.name}</Typography>}
          <Button
            color="error"
            variant="contained"
            disabled={!restoreFile || !!(restoreProgress && !restoreProgress.done)}
            onClick={() => {
              setRestoreConfirmText('');
              setRestoreConfirmOpen(true);
            }}
          >
            Восстановить
          </Button>
        </Stack>
        {restoreProgress && !restoreProgress.done ? (
          <Stack direction="row" spacing={2} alignItems="center" mt={2}>
            <CircularProgress variant={restoreWaitingForBackend ? 'indeterminate' : 'determinate'} value={restoreProgress.percent} size={32} />
            <Typography variant="body2">
              {restoreWaitingForBackend
                ? 'Backend перезапускается, ждём восстановления соединения…'
                : `${restoreProgress.percent}% — ${restoreProgress.step}`}
            </Typography>
          </Stack>
        ) : (
          restoreProgress?.done && (
            <Alert severity={restoreProgress.error ? 'error' : 'success'} sx={{ mt: 2 }}>
              {restoreProgress.error ?? 'Восстановление завершено'}
            </Alert>
          )
        )}
        {restoreError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {restoreError}
          </Alert>
        )}
      </Paper>

      <Dialog open={restoreConfirmOpen} onClose={() => setRestoreConfirmOpen(false)}>
        <DialogTitle>Восстановить базу данных?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Это НЕОБРАТИМО заменит ВСЮ текущую базу данных содержимым файла «{restoreFile?.name}
            ». Все текущие данные (пиры, серверы, организации, пользователи) будут потеряны.
            Чтобы подтвердить, введите слово «{RESTORE_CONFIRMATION_PHRASE}»:
          </DialogContentText>
          <TextField
            fullWidth
            sx={{ mt: 2 }}
            value={restoreConfirmText}
            onChange={(e) => setRestoreConfirmText(e.target.value)}
            placeholder={RESTORE_CONFIRMATION_PHRASE}
            autoFocus
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestoreConfirmOpen(false)}>Отмена</Button>
          <Button
            variant="contained"
            color="error"
            disabled={restoreConfirmText !== RESTORE_CONFIRMATION_PHRASE || restoreMutation.isPending}
            onClick={() => restoreMutation.mutate()}
          >
            Восстановить
          </Button>
        </DialogActions>
      </Dialog>

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
