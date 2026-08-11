import {
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AuditLogEntry, fetchAuditLog } from '../api/auditLog';

const methodColor: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  POST: 'success',
  PATCH: 'warning',
  PUT: 'warning',
  DELETE: 'error',
  GET: 'default',
};

export function AuditLogPage() {
  const { data: entries, isLoading } = useQuery({
    queryKey: ['audit-log'],
    queryFn: () => fetchAuditLog(200),
    // Раз в минуту — журнал не нужен "в реальном времени", это просмотр истории, а не
    // живой дашборд.
    refetchInterval: 60_000,
  });
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  return (
    <>
      <Typography variant="h5" mb={2}>
        Журнал действий
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Последние {entries?.length ?? 0} изменяющих запросов (создание/изменение/удаление, плюс скачивание бэкапа БД) —
        нажмите на строку, чтобы увидеть тело запроса (пароли/секреты скрыты).
      </Typography>
      <Paper sx={{ p: 2 }}>
        <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Время</TableCell>
              <TableCell>Пользователь</TableCell>
              <TableCell>Действие</TableCell>
              <TableCell>Цель</TableCell>
              <TableCell>Статус</TableCell>
              <TableCell>IP</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entries?.map((entry) => (
              <TableRow key={entry.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelected(entry)}>
                <TableCell>{new Date(entry.createdAt).toLocaleString()}</TableCell>
                <TableCell>{entry.actorEmail ?? '—'}</TableCell>
                <TableCell>
                  <Chip size="small" label={entry.method} color={methodColor[entry.method] ?? 'default'} sx={{ mr: 1 }} />
                  {entry.path}
                </TableCell>
                <TableCell>{entry.targetId ? `${entry.targetId.slice(0, 8)}…` : '—'}</TableCell>
                <TableCell>{entry.statusCode}</TableCell>
                <TableCell>{entry.ipAddress ?? '—'}</TableCell>
              </TableRow>
            ))}
            {!isLoading && (entries?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>Журнал пока пуст</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </TableContainer>
      </Paper>

      <Dialog open={!!selected} onClose={() => setSelected(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {selected?.method} {selected?.path}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={1}>
            {selected && new Date(selected.createdAt).toLocaleString()} · {selected?.actorEmail ?? '—'} · {selected?.ipAddress ?? '—'}
          </Typography>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
            {selected?.body ? JSON.stringify(selected.body, null, 2) : '(тело запроса пустое)'}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
