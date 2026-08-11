import {
  Alert,
  Button,
  Link,
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
import { FormEvent, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { getErrorMessage } from '../api/errors';
import { createOrganization, deleteOrganization, fetchOrganizations } from '../api/organizations';
import { fetchPeers } from '../api/peers';

export function OrganizationsPage() {
  const queryClient = useQueryClient();
  const { data: organizations, isLoading } = useQuery({ queryKey: ['organizations'], queryFn: fetchOrganizations });
  // Без org-фильтра — суперадмину отдаёт peers всех клиентов разом, этого достаточно для
  // подсчёта количества по каждому (см. ниже) без отдельного агрегирующего эндпоинта.
  const { data: allPeers } = useQuery({ queryKey: ['peers'], queryFn: () => fetchPeers() });
  const peerCountByOrgId = new Map<string | null, number>();
  allPeers?.forEach((peer) => {
    peerCountByOrgId.set(peer.organizationId, (peerCountByOrgId.get(peer.organizationId) ?? 0) + 1);
  });
  const peersWithoutClient = peerCountByOrgId.get(null) ?? 0;

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setName('');
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
    createMutation.mutate({ name });
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5">Клиенты</Typography>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" mb={2}>
          Новый клиент
        </Typography>
        <form onSubmit={handleSubmit}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
            <TextField label="Название" value={name} onChange={(e) => setName(e.target.value)} required />
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              Создать
            </Button>
          </Stack>
        </form>
        <Typography variant="body2" color="text.secondary" mt={1}>
          Пользователей (администраторов и сотрудников) для этой организации добавьте отдельно
          на вкладке «Пользователи».
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Название</TableCell>
              <TableCell>Создана</TableCell>
              <TableCell align="right">Peers</TableCell>
              <TableCell align="right">Действия</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {organizations?.map((org) => (
              <TableRow key={org.id}>
                <TableCell>
                  <Link component={RouterLink} to={`/organizations/${org.id}`}>
                    {org.name}
                  </Link>
                </TableCell>
                <TableCell>{new Date(org.createdAt).toLocaleString()}</TableCell>
                <TableCell align="right">{peerCountByOrgId.get(org.id) ?? 0}</TableCell>
                <TableCell align="right">
                  <Button size="small" color="error" onClick={() => deleteMutation.mutate(org.id)}>
                    Удалить
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && organizations?.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>Клиентов пока нет</TableCell>
              </TableRow>
            )}
            {!isLoading && (
              <TableRow>
                <TableCell sx={{ fontStyle: 'italic' }} colSpan={2}>
                  Без клиента
                </TableCell>
                <TableCell align="right" sx={{ fontStyle: 'italic' }}>
                  {peersWithoutClient}
                </TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
        </Table>
        </TableContainer>
      </Paper>
    </Stack>
  );
}
