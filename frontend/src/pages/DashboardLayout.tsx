import { AppBar, Box, Button, Container, Divider, IconButton, Menu, MenuItem, Toolbar, Tooltip, Typography } from '@mui/material';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import { useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useThemeMode } from '../theme/ThemeModeContext';

const roleLabels: Record<string, string> = {
  super_admin: 'Суперадмин',
  org_admin: 'Администратор организации',
  org_user: 'Пользователь',
};

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useThemeMode();
  const location = useLocation();
  const navigate = useNavigate();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

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
            </>
          )}
          {(user?.role === 'super_admin' || user?.role === 'org_admin') && (
            <Button color="inherit" {...navButtonProps('/users')}>
              Пользователи
            </Button>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={mode === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            <IconButton color="inherit" onClick={toggleMode}>
              {mode === 'dark' ? <Brightness7Icon /> : <Brightness4Icon />}
            </IconButton>
          </Tooltip>
          <Button color="inherit" onClick={(e) => setMenuAnchor(e.currentTarget)} sx={{ textTransform: 'none' }}>
            <Box sx={{ textAlign: 'left', lineHeight: 1.2 }}>
              <Typography variant="body2" component="div">
                {user?.email} ▾
              </Typography>
              <Typography variant="caption" component="div" sx={{ opacity: 0.8 }}>
                {user ? roleLabels[user.role] : ''}
              </Typography>
            </Box>
          </Button>
          <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
            {user?.role === 'super_admin' && [
              <MenuItem
                key="settings"
                onClick={() => {
                  setMenuAnchor(null);
                  navigate('/settings');
                }}
              >
                Настройки
              </MenuItem>,
              <MenuItem
                key="audit-log"
                onClick={() => {
                  setMenuAnchor(null);
                  navigate('/audit-log');
                }}
              >
                Журнал действий
              </MenuItem>,
              <Divider key="divider" />,
            ]}
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                logout();
              }}
            >
              Выйти
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Container sx={{ mt: 4, mb: 4 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
