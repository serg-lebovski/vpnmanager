import {
  Alert,
  Button,
  Chip,
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
  deleteTelegramRegistration,
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
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const broadcastMutation = useMutation({
    mutationFn: () => broadcastTelegramMessage(broadcastText),
    onSuccess: (result) => {
      setBroadcastResult(`Отправлено: ${result.sent}${result.failed > 0 ? `, не удалось: ${result.failed}` : ''}`);
      setBroadcastError(null);
      setBroadcastText('');
    },
    onError: (err) => {
      setBroadcastError(getErrorMessage(err, 'Не удалось отправить рассылку'));
      setBroadcastResult(null);
    },
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
    </Stack>
  );
}
