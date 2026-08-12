import {
  Alert,
  Button,
  Checkbox,
  Chip,
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
import { useState } from 'react';
import { getErrorMessage } from '../api/errors';
import {
  approveTelegramRegistration,
  broadcastTelegramMessage,
  deleteTelegramBroadcast,
  deleteTelegramRegistration,
  fetchTelegramBroadcasts,
  fetchTelegramRegistrations,
} from '../api/telegramRegistrations';

const statusLabels: Record<string, string> = {
  pending: 'Ожидает подтверждения',
  approved: 'Подтверждён',
};

const statusColor: Record<string, 'warning' | 'success'> = {
  pending: 'warning',
  approved: 'success',
};

export function TelegramBotPage() {
  const queryClient = useQueryClient();
  const { data: registrations, isLoading } = useQuery({
    queryKey: ['telegram-registrations'],
    queryFn: fetchTelegramRegistrations,
  });

  const approveMutation = useMutation({
    mutationFn: approveTelegramRegistration,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-registrations'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteTelegramRegistration,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['telegram-registrations'] }),
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

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Telegram-бот</Typography>

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
                    <Button size="small" color="error" onClick={() => deleteMutation.mutate(r.id)} disabled={deleteMutation.isPending}>
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
    </Stack>
  );
}
