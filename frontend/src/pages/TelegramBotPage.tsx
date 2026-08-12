import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { fetchSettings, updateSettings } from '../api/settings';
import {
  approveTelegramRegistration,
  broadcastTelegramMessage,
  deleteTelegramBroadcast,
  deleteTelegramRegistration,
  fetchTelegramBotLogs,
  fetchTelegramBroadcasts,
  fetchTelegramRegistrations,
} from '../api/telegramRegistrations';
import { TelegramRegistration } from '../api/types';

const statusLabels: Record<string, string> = {
  pending: 'Ожидает подтверждения',
  approved: 'Подтверждён',
};

const statusColor: Record<string, 'warning' | 'success'> = {
  pending: 'warning',
  approved: 'success',
};

const logLevelColor: Record<string, 'default' | 'warning' | 'error'> = {
  info: 'default',
  warn: 'warning',
  error: 'error',
};

export function TelegramBotPage() {
  const queryClient = useQueryClient();
  const { data: registrations, isLoading } = useQuery({
    queryKey: ['telegram-registrations'],
    queryFn: fetchTelegramRegistrations,
  });

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [textsSaved, setTextsSaved] = useState(false);
  const [textsError, setTextsError] = useState<string | null>(null);
  useEffect(() => {
    if (settings) {
      setWelcomeMessage(settings.telegramWelcomeMessage ?? '');
      setInfoMessage(settings.telegramInfoMessage ?? '');
    }
  }, [settings]);
  const saveTextsMutation = useMutation({
    mutationFn: () => updateSettings({ telegramWelcomeMessage: welcomeMessage, telegramInfoMessage: infoMessage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setTextsSaved(true);
      setTextsError(null);
    },
    onError: (err) => {
      setTextsError(getErrorMessage(err, 'Не удалось сохранить тексты бота'));
      setTextsSaved(false);
    },
  });

  const approveMutation = useMutation({
    mutationFn: approveTelegramRegistration,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-registrations'] }),
  });
  const [deleteTarget, setDeleteTarget] = useState<TelegramRegistration | null>(null);
  const deleteMutation = useMutation({
    mutationFn: (revokePeers: boolean) => deleteTelegramRegistration(deleteTarget!.id, revokePeers),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['telegram-registrations'] });
      setDeleteTarget(null);
    },
  });

  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastPin, setBroadcastPin] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const broadcastMutation = useMutation({
    mutationFn: () => broadcastTelegramMessage(broadcastText, broadcastPin),
    onSuccess: (result) => {
      setBroadcastResult(`Отправлено: ${result.sent}${result.failed > 0 ? `, не удалось: ${result.failed}` : ''}`);
      setBroadcastError(null);
      setBroadcastText('');
      queryClient.invalidateQueries({ queryKey: ['telegram-broadcasts'] });
    },
    onError: (err) => {
      setBroadcastError(getErrorMessage(err, 'Не удалось отправить рассылку'));
      setBroadcastResult(null);
    },
  });

  const { data: broadcasts, isLoading: broadcastsLoading } = useQuery({
    queryKey: ['telegram-broadcasts'],
    queryFn: fetchTelegramBroadcasts,
  });
  const deleteBroadcastMutation = useMutation({
    mutationFn: deleteTelegramBroadcast,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-broadcasts'] }),
  });

  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ['telegram-bot-logs'],
    queryFn: fetchTelegramBotLogs,
    refetchInterval: 15_000,
  });

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Telegram-бот</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Тексты бота
        </Typography>
        <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
          <TextField
            label="Приветствие (первое сообщение на /start)"
            multiline
            minRows={2}
            maxRows={6}
            value={welcomeMessage}
            onChange={(e) => {
              setWelcomeMessage(e.target.value);
              setTextsSaved(false);
            }}
          />
          <TextField
            label="Дополнительная информация (кнопка «ℹ️ Информация»)"
            multiline
            minRows={2}
            maxRows={6}
            value={infoMessage}
            onChange={(e) => {
              setInfoMessage(e.target.value);
              setTextsSaved(false);
            }}
          />
          <Button
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
            disabled={saveTextsMutation.isPending}
            onClick={() => saveTextsMutation.mutate()}
          >
            Сохранить
          </Button>
          {textsSaved && <Alert severity="success">Тексты сохранены.</Alert>}
          {textsError && <Alert severity="error">{textsError}</Alert>}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Регистрации
        </Typography>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>ФИО</TableCell>
                <TableCell>Организация</TableCell>
                <TableCell>Telegram</TableCell>
                <TableCell>Статус</TableCell>
                <TableCell align="right">Действия</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {registrations?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.fullName}</TableCell>
                  <TableCell>{r.organizationName}</TableCell>
                  <TableCell>{r.telegramUsername ? `@${r.telegramUsername}` : r.telegramChatId}</TableCell>
                  <TableCell>
                    <Chip size="small" label={statusLabels[r.status] ?? r.status} color={statusColor[r.status]} />
                  </TableCell>
                  <TableCell align="right">
                    {r.status === 'pending' && (
                      <Button size="small" onClick={() => approveMutation.mutate(r.id)} disabled={approveMutation.isPending}>
                        Подтвердить
                      </Button>
                    )}
                    <Button size="small" color="error" onClick={() => setDeleteTarget(r)}>
                      Удалить
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && (registrations?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>Регистраций пока нет</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Рассылка подтверждённым пользователям
        </Typography>
        <Stack spacing={1.5} sx={{ maxWidth: 480 }}>
          <TextField
            label="Текст сообщения"
            multiline
            minRows={3}
            maxRows={8}
            value={broadcastText}
            onChange={(e) => setBroadcastText(e.target.value)}
          />
          <FormControlLabel
            control={<Checkbox checked={broadcastPin} onChange={(e) => setBroadcastPin(e.target.checked)} />}
            label="Закрепить сообщение в чате у получателей"
          />
          <Button
            variant="contained"
            sx={{ alignSelf: 'flex-start' }}
            disabled={!broadcastText.trim() || broadcastMutation.isPending}
            onClick={() => broadcastMutation.mutate()}
          >
            Отправить всем подтверждённым
          </Button>
          {broadcastResult && <Alert severity="success">{broadcastResult}</Alert>}
          {broadcastError && <Alert severity="error">{broadcastError}</Alert>}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          История рассылок
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>
          Удаление рассылки убирает сообщение из чата у всех получателей, не только из этого
          списка.
        </Typography>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Текст</TableCell>
                <TableCell align="right">Получателей</TableCell>
                <TableCell>Закреплено</TableCell>
                <TableCell>Отправлено</TableCell>
                <TableCell align="right">Действия</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {broadcasts?.map((b) => (
                <TableRow key={b.id}>
                  <TableCell sx={{ maxWidth: 320, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.text}</TableCell>
                  <TableCell align="right">{b.recipientCount}</TableCell>
                  <TableCell>{b.pinned ? 'да' : '—'}</TableCell>
                  <TableCell>{new Date(b.createdAt).toLocaleString()}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      color="error"
                      onClick={() => deleteBroadcastMutation.mutate(b.id)}
                      disabled={deleteBroadcastMutation.isPending}
                    >
                      Удалить
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!broadcastsLoading && (broadcasts?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>Рассылок пока не было</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Журнал бота
        </Typography>
        <TableContainer sx={{ overflowX: 'auto', maxHeight: 480 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Время</TableCell>
                <TableCell>Уровень</TableCell>
                <TableCell>Chat ID</TableCell>
                <TableCell>Сообщение</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {logs?.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(entry.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <Chip size="small" label={entry.level} color={logLevelColor[entry.level]} />
                  </TableCell>
                  <TableCell>{entry.chatId ?? '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.message}</TableCell>
                </TableRow>
              ))}
              {!logsLoading && (logs?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>Записей пока нет</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Удалить заявку «{deleteTarget?.fullName}»?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Что сделать с уже выданными этому пользователю peers (если есть)?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Отмена</Button>
          <Button onClick={() => deleteMutation.mutate(false)} disabled={deleteMutation.isPending}>
            Оставить peers
          </Button>
          <Button color="error" onClick={() => deleteMutation.mutate(true)} disabled={deleteMutation.isPending}>
            Отозвать и удалить peers
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
