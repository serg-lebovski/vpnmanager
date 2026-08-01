import {
  Alert,
  Button,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { createOrganization, deleteOrganization, fetchOrganizations } from '../api/organizations';

export function OrganizationsPage() {
  const queryClient = useQueryClient();
  const { data: organizations, isLoading } = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations });

  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setName('');
      setAdminEmail('');
      setAdminPassword('');
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось создать организацию')),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteOrganization,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['organizations'] }),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate({ name, adminEmail, adminPassword });
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Организации (клиентские аккаунты)</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Новая организация
        </Typography>
        <form onSubmit={handleSubmit}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
            <TextField label="Название" value={name} onChange={(e) => setName(e.target.value)} required />
            <TextField
              label="Email администратора"
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              required
            />
            <TextField
              label="Пароль администратора"
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              required
            />
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              Создать
            </Button>
          </Stack>
        </form>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Название</TableCell>
              <TableCell>Создана</TableCell>
              <TableCell align="right">Действия</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {organizations?.map((org) => (
              <TableRow key={org.id}>
                <TableCell>{org.name}</TableCell>
                <TableCell>{new Date(org.createdAt).toLocaleString()}</TableCell>
                <TableCell align="right">
                  <Button size="small" color="error" onClick={() => deleteMutation.mutate(org.id)}>
                    Удалить
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && organizations?.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>Организаций пока нет</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
