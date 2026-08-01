import {
  Alert,
  Button,
  MenuItem,
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
import { fetchOrganizations } from '../api/organizations';
import { Role } from '../api/types';
import { createUser, deleteUser, fetchUsers } from '../api/users';
import { useAuth } from '../auth/AuthContext';

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const isSuperAdmin = currentUser?.role === 'super_admin';

  const { data: users, isLoading } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  const { data: organizations } = useQuery({
    queryKey: ['organizations'],
    queryFn: fetchOrganizations,
    enabled: isSuperAdmin,
  });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(isSuperAdmin ? 'org_admin' : 'org_user');
  const [organizationId, setOrganizationId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEmail('');
      setPassword('');
      setError(null);
    },
    onError: (err) => setError(getErrorMessage(err, 'Не удалось создать пользователя')),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    createMutation.mutate({
      email,
      password,
      role: isSuperAdmin ? role : 'org_user',
      organizationId: isSuperAdmin ? (role === 'super_admin' ? undefined : organizationId) : undefined,
    });
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Пользователи</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Новый пользователь
        </Typography>
        <form onSubmit={handleSubmit}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start" flexWrap="wrap">
            <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <TextField
              label="Пароль"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {isSuperAdmin && (
              <TextField select label="Роль" value={role} onChange={(e) => setRole(e.target.value as Role)} sx={{ minWidth: 200 }}>
                <MenuItem value="org_admin">Администратор организации</MenuItem>
                <MenuItem value="org_user">Пользователь организации</MenuItem>
                <MenuItem value="super_admin">Суперадмин</MenuItem>
              </TextField>
            )}
            {isSuperAdmin && role !== 'super_admin' && (
              <TextField
                select
                label="Организация"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                sx={{ minWidth: 200 }}
                required
              >
                {organizations?.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
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
              <TableCell>Email</TableCell>
              <TableCell>Роль</TableCell>
              <TableCell align="right">Действия</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users?.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.role}</TableCell>
                <TableCell align="right">
                  <Button size="small" color="error" onClick={() => deleteMutation.mutate(u.id)}>
                    Удалить
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && users?.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>Пользователей пока нет</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
