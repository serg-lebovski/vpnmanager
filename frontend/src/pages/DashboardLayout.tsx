import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material';
import { Link as RouterLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const roleLabels: Record<string, string> = {
  super_admin: 'Суперадмин',
  org_admin: 'Администратор организации',
  org_user: 'Пользователь',
};

export function DashboardLayout() {
  const { user, logout } = useAuth();

  return (
    <Box>
      <AppBar position="static">
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 0 }}>
            VPN Manager
          </Typography>
          <Button color="inherit" component={RouterLink} to="/">
            Peers
          </Button>
          {user?.role === 'super_admin' && (
            <>
              <Button color="inherit" component={RouterLink} to="/servers">
                Серверы
              </Button>
              <Button color="inherit" component={RouterLink} to="/organizations">
                Организации
              </Button>
              <Button color="inherit" component={RouterLink} to="/bridge">
                Мост
              </Button>
            </>
          )}
          {(user?.role === 'super_admin' || user?.role === 'org_admin') && (
            <Button color="inherit" component={RouterLink} to="/users">
              Пользователи
            </Button>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="body2">
            {user?.email} ({user ? roleLabels[user.role] : ''})
          </Typography>
          <Button color="inherit" onClick={logout}>
            Выйти
          </Button>
        </Toolbar>
      </AppBar>
      <Container sx={{ mt: 4, mb: 4 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
