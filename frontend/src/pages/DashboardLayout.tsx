import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const roleLabels: Record<string, string> = {
  super_admin: 'Суперадмин',
  org_admin: 'Администратор организации',
  org_user: 'Пользователь',
};

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();

  // "/" — только точное совпадение (иначе подсвечивался бы всегда, это префикс всех
  // путей); остальные вкладки — по префиксу, чтобы вложенные страницы (например,
  // /organizations/:id) тоже подсвечивали свой родительский пункт меню.
  function isActive(path: string): boolean {
    return path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  }

  function navButtonProps(path: string) {
    return {
      component: RouterLink,
      to: path,
      variant: isActive(path) ? ('outlined' as const) : undefined,
      sx: isActive(path) ? { borderColor: 'currentColor' } : undefined,
    };
  }

  return (
    <Box>
      <AppBar position="static">
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 0 }}>
            VPN Manager
          </Typography>
          <Button color="inherit" {...navButtonProps('/')}>
            Peers
          </Button>
          {user?.role === 'super_admin' && (
            <>
              <Button color="inherit" {...navButtonProps('/dashboard')}>
                Дашборд
              </Button>
              <Button color="inherit" {...navButtonProps('/servers')}>
                Серверы
              </Button>
              <Button color="inherit" {...navButtonProps('/organizations')}>
                Клиенты
              </Button>
              <Button color="inherit" {...navButtonProps('/bridge')}>
                Мост
              </Button>
              <Button color="inherit" {...navButtonProps('/settings')}>
                Настройки
              </Button>
            </>
          )}
          {(user?.role === 'super_admin' || user?.role === 'org_admin') && (
            <Button color="inherit" {...navButtonProps('/users')}>
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
