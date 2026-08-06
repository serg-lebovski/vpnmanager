import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useMemo, useState } from 'react';
import { getErrorMessage } from '../api/errors';
import { fetchOrganizations } from '../api/organizations';
import { AppUser, Role } from '../api/types';
import { createUser, deleteUser, fetchUsers, updateUser } from '../api/users';
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

  const [editingUser, setEditingUser] = useState<AppUser | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState<Role>('org_user');
  const [editOrganizationId, setEditOrganizationId] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: () =>
      updateUser(editingUser!.id, {
        email: editEmail,
        password: editPassword || undefined,
        role: editRole,
        organizationId: editRole === 'super_admin' ? null : editOrganizationId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditingUser(null);
    },
    onError: (err) => setEditError(getErrorMessage(err, 'Не удалось сохранить изменения')),
  });

  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Фильтр по email (де-факто "имени" пользователя — своего поля name у User нет) + сортировка
  // по клику на заголовок колонки, по умолчанию по возрастанию.
  const visibleUsers = useMemo(() => {
    const filtered = (users ?? []).filter((u) => u.email.toLowerCase().includes(search.trim().toLowerCase()));
    const sorted = filtered.sort((a, b) => a.email.localeCompare(b.email));
    return sortDir === 'asc' ? sorted : sorted.reverse();
  }, [users, search, sortDir]);

  function openEdit(u: AppUser) {
    setEditingUser(u);
    setEditEmail(u.email);
    setEditPassword('');
    setEditRole(u.role);
    setEditOrganizationId(u.organizationId ?? '');
    setEditError(null);
  }

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
            <TextField label="Email или логин" value={email} onChange={(e) => setEmail(e.target.value)} required />
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
        <TextField
          size="small"
          label="Поиск по email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ mb: 2, minWidth: 260 }}
        />
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sortDirection={sortDir}>
                <TableSortLabel active direction={sortDir} onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                  Email
                </TableSortLabel>
              </TableCell>
              <TableCell>Роль</TableCell>
              <TableCell>Организация</TableCell>
              <TableCell align="right">Действия</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleUsers.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.role}</TableCell>
                <TableCell>{organizations?.find((o) => o.id === u.organizationId)?.name ?? '—'}</TableCell>
                <TableCell align="right">
                  {isSuperAdmin && (
                    <Button size="small" onClick={() => openEdit(u)}>
                      Изменить
                    </Button>
                  )}
                  <Button size="small" color="error" onClick={() => deleteMutation.mutate(u.id)}>
                    Удалить
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && visibleUsers.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>{search ? 'Ничего не найдено' : 'Пользователей пока нет'}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={!!editingUser} onClose={() => setEditingUser(null)} fullWidth maxWidth="xs">
        <DialogTitle>Изменить пользователя</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Email или логин" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required />
            <TextField
              label="Новый пароль"
              type="password"
              value={editPassword}
              onChange={(e) => setEditPassword(e.target.value)}
              helperText="Оставьте пустым, чтобы не менять"
            />
            <TextField select label="Роль" value={editRole} onChange={(e) => setEditRole(e.target.value as Role)}>
              <MenuItem value="org_admin">Администратор организации</MenuItem>
              <MenuItem value="org_user">Пользователь организации</MenuItem>
              <MenuItem value="super_admin">Суперадмин</MenuItem>
            </TextField>
            {editRole !== 'super_admin' && (
              <TextField
                select
                label="Организация"
                value={editOrganizationId}
                onChange={(e) => setEditOrganizationId(e.target.value)}
                required
              >
                {organizations?.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {editError && <Alert severity="error">{editError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingUser(null)}>Отмена</Button>
          <Button variant="contained" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate()}>
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
