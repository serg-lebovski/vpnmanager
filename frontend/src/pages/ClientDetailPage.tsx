import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
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
import { FormEvent, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { fetchBridges } from '../api/bridges';
import { getErrorMessage } from '../api/errors';
import { deleteOrganization, fetchOrganization, updateOrganization } from '../api/organizations';
import { fetchPeers } from '../api/peers';
import { fetchServers } from '../api/servers';
import { Role } from '../api/types';
import { createUser, deleteUser, fetchUsers, updateUser } from '../api/users';

const statusColor: Record<string, 'success' | 'default'> = {
  active: 'success',
  revoked: 'default',
};

export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: organization, isLoading } = useQuery({
    queryKey: ['organizations', id],
    queryFn: () => fetchOrganization(id!),
    enabled: !!id,
  });
  const { data: allUsers } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });
  const { data: peers } = useQuery({ queryKey: ['peers', id], queryFn: () => fetchPeers(id) });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: fetchServers });
  const { data: bridges } = useQuery({ queryKey: ['bridges'], queryFn: fetchBridges });

  const users = allUsers?.filter((u) => u.organizationId === id);
  // Self-серверы отдельно не выбираются — доступ к ним даётся через мост (см. ниже), а не
  // напрямую (это и есть весь смысл моста — клиенты не подключаются к backend-серверам
  // напрямую).
  const selectableServers = servers?.filter((s) => !s.isSelf);

  const [name, setName] = useState('');
  const [allowedServerIds, setAllowedServerIds] = useState<string[]>([]);
  const [blockedBridgeIds, setBlockedBridgeIds] = useState<string[]>([]);
  useEffect(() => {
    if (organization) {
      setName(organization.name);
      setAllowedServerIds(organization.allowedServerIds);
      setBlockedBridgeIds(organization.blockedBridgeIds);
    }
  }, [organization]);

  const renameMutation = useMutation({
    mutationFn: () => updateOrganization(id!, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setRenameError(null);
    },
    onError: (err) => setRenameError(getErrorMessage(err, 'Не удалось переименовать клиента')),
  });
  const [renameError, setRenameError] = useState<string | null>(null);

  const accessMutation = useMutation({
    mutationFn: () => updateOrganization(id!, { allowedServerIds, blockedBridgeIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setAccessError(null);
    },
    onError: (err) => setAccessError(getErrorMessage(err, 'Не удалось сохранить доступ')),
  });
  const [accessError, setAccessError] = useState<string | null>(null);

  function toggleAllowedServer(serverId: string, checked: boolean) {
    setAllowedServerIds((prev) => (checked ? [...prev, serverId] : prev.filter((sid) => sid !== serverId)));
  }

  function toggleBridgeAllowed(bridgeId: string, allowed: boolean) {
    // Чекбокс на экране означает "разрешён" — в blockedBridgeIds храним обратное.
    setBlockedBridgeIds((prev) => (allowed ? prev.filter((bid) => bid !== bridgeId) : [...prev, bridgeId]));
  }

  const deleteOrgMutation = useMutation({
    mutationFn: () => deleteOrganization(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      navigate('/organizations');
    },
  });

  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userRole, setUserRole] = useState<Role>('org_user');
  const [userError, setUserError] = useState<string | null>(null);

  const createUserMutation = useMutation({
    mutationFn: () => createUser({ email: userEmail, password: userPassword, role: userRole, organizationId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setUserEmail('');
      setUserPassword('');
      setUserError(null);
    },
    onError: (err) => setUserError(getErrorMessage(err, 'Не удалось добавить пользователя')),
  });

  const deleteUserMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  function handleAddUser(event: FormEvent) {
    event.preventDefault();
    createUserMutation.mutate();
  }

  // Пользователи, которых можно ПЕРЕНЕСТИ в этого клиента, а не заводить с нуля — все,
  // кто сейчас не привязан к этой же организации (включая "без клиента" и чужих клиентов).
  const [existingUserId, setExistingUserId] = useState('');
  const assignableUsers = allUsers?.filter((u) => u.organizationId !== id);

  const assignUserMutation = useMutation({
    mutationFn: () => updateUser(existingUserId, { organizationId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setExistingUserId('');
    },
  });

  if (isLoading || !organization) {
    return <Typography>Загрузка...</Typography>;
  }

  return (
    <Stack spacing={3}>
      <Button component={RouterLink} to="/organizations" size="small" sx={{ alignSelf: 'flex-start' }}>
        ← Все клиенты
      </Button>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Клиент
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
          <TextField label="Название" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button
            variant="contained"
            disabled={renameMutation.isPending || name === organization.name}
            onClick={() => renameMutation.mutate()}
          >
            Сохранить
          </Button>
          <Box flex={1} />
          <Button color="error" onClick={() => deleteOrgMutation.mutate()}>
            Удалить клиента
          </Button>
        </Stack>
        {renameError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {renameError}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={1}>
          Доступ к серверам и мостам
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>
          Мосты — по умолчанию доступны все видимые этому клиенту (общие + его собственные),
          снимите галочку, чтобы забрать доступ. Обычные серверы — по умолчанию недоступны
          напрямую (в обход моста), доступ выдаётся явно.
        </Typography>

        <Typography variant="body2" fontWeight="bold" mb={0.5}>
          Мосты
        </Typography>
        <Stack direction="row" flexWrap="wrap" useFlexGap mb={2}>
          {bridges?.map((bridge) => (
            <FormControlLabel
              key={bridge.id}
              sx={{ minWidth: 220 }}
              control={
                <Checkbox
                  checked={!blockedBridgeIds.includes(bridge.id)}
                  onChange={(e) => toggleBridgeAllowed(bridge.id, e.target.checked)}
                />
              }
              label={bridge.name}
            />
          ))}
          {bridges?.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Мостов пока нет
            </Typography>
          )}
        </Stack>

        <Typography variant="body2" fontWeight="bold" mb={0.5}>
          Обычные серверы (в обход моста)
        </Typography>
        <Stack direction="row" flexWrap="wrap" useFlexGap mb={2}>
          {selectableServers?.map((server) => (
            <FormControlLabel
              key={server.id}
              sx={{ minWidth: 220 }}
              control={
                <Checkbox
                  checked={allowedServerIds.includes(server.id)}
                  onChange={(e) => toggleAllowedServer(server.id, e.target.checked)}
                />
              }
              label={server.name}
            />
          ))}
          {selectableServers?.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Обычных серверов пока нет
            </Typography>
          )}
        </Stack>

        <Button variant="contained" disabled={accessMutation.isPending} onClick={() => accessMutation.mutate()}>
          Сохранить доступ
        </Button>
        {accessError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {accessError}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Пользователи
        </Typography>
        <form onSubmit={handleAddUser}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start" mb={2}>
            <TextField label="Email" type="email" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} required />
            <TextField
              label="Пароль"
              type="password"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              required
            />
            <TextField select label="Роль" value={userRole} onChange={(e) => setUserRole(e.target.value as Role)} sx={{ minWidth: 200 }}>
              <MenuItem value="org_admin">Администратор</MenuItem>
              <MenuItem value="org_user">Пользователь</MenuItem>
            </TextField>
            <Button type="submit" variant="contained" disabled={createUserMutation.isPending}>
              Добавить
            </Button>
          </Stack>
        </form>
        {userError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {userError}
          </Alert>
        )}
        {assignableUsers && assignableUsers.length > 0 && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start" mb={2}>
            <TextField
              select
              label="Добавить имеющегося пользователя"
              size="small"
              value={existingUserId}
              onChange={(e) => setExistingUserId(e.target.value)}
              sx={{ minWidth: 260 }}
              helperText="Перенести уже существующего пользователя (с другого клиента или без клиента) сюда"
            >
              {assignableUsers.map((u) => (
                <MenuItem key={u.id} value={u.id}>
                  {u.email} {u.organizationId ? '' : '(без клиента)'}
                </MenuItem>
              ))}
            </TextField>
            <Button
              size="small"
              variant="outlined"
              disabled={!existingUserId || assignUserMutation.isPending}
              onClick={() => assignUserMutation.mutate()}
            >
              Добавить
            </Button>
          </Stack>
        )}
        <TableContainer sx={{ overflowX: 'auto' }}>
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
                  <Button size="small" color="error" onClick={() => deleteUserMutation.mutate(u.id)}>
                    Убрать
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {users?.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>У этого клиента пока нет пользователей</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </TableContainer>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Peers
        </Typography>
        <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Название</TableCell>
              <TableCell>IP</TableCell>
              <TableCell>Статус</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {peers?.map((peer) => (
              <TableRow key={peer.id}>
                <TableCell>{peer.name}</TableCell>
                <TableCell>{peer.allowedIp}</TableCell>
                <TableCell>
                  <Chip size="small" label={peer.status} color={statusColor[peer.status]} />
                </TableCell>
              </TableRow>
            ))}
            {peers?.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>У этого клиента пока нет peers</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </TableContainer>
      </Paper>
    </Stack>
  );
}
