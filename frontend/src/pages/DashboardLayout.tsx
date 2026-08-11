import {
  AppBar,
  Box,
  Button,
  Container,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import MenuIcon from '@mui/icons-material/Menu';
import { useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useThemeMode } from '../theme/ThemeModeContext';

const roleLabels: Record<string, string> = {
  super_admin: 'Суперадмин',
  org_admin: 'Администратор организации',
  org_user: 'Пользователь',
  engineer: 'Инженер',
};

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useThemeMode();
  const location = useLocation();
  const navigate = useNavigate();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const theme = useTheme();
  // Пунктов навигации у суперадмина (Peers/Дашборд/Серверы/Клиенты/Мост/Пользователи) в один
  // ряд Toolbar не влезает на телефоне — ниже md прячем их за гамбургер-меню (Drawer), сама
  // строка Toolbar на десктопе остаётся как есть.
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

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
          {isMobile && (
            <IconButton color="inherit" edge="start" aria-label="Меню" onClick={() => setDrawerOpen(true)}>
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" sx={{ flexGrow: 0 }} noWrap>
            VPN Manager
          </Typography>
          {!isMobile && (
            <>
              <Button color="inherit" {...navButtonProps('/')}>
                Peers
              </Button>
              {(user?.role === 'super_admin' || user?.role === 'engineer') && (
                <Button color="inherit" {...navButtonProps('/dashboard')}>
                  Дашборд
                </Button>
              )}
              {user?.role === 'super_admin' && (
                <>
                  <Button color="inherit" {...navButtonProps('/servers')}>
                    Серверы
                  </Button>
                  <Button color="inherit" {...navButtonProps('/organizations')}>
                    Клиенты
                  </Button>
                </>
              )}
              {(user?.role === 'super_admin' || user?.role === 'engineer') && (
                <Button color="inherit" {...navButtonProps('/bridge')}>
                  Мост
                </Button>
              )}
              {(user?.role === 'super_admin' || user?.role === 'org_admin') && (
                <Button color="inherit" {...navButtonProps('/users')}>
                  Пользователи
                </Button>
              )}
            </>
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
      <Drawer anchor="left" open={isMobile && drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Box sx={{ width: 240 }} role="presentation" onClick={() => setDrawerOpen(false)}>
          <List>
            <ListItemButton component={RouterLink} to="/" selected={isActive('/')}>
              <ListItemText primary="Peers" />
            </ListItemButton>
            {(user?.role === 'super_admin' || user?.role === 'engineer') && (
              <ListItemButton component={RouterLink} to="/dashboard" selected={isActive('/dashboard')}>
                <ListItemText primary="Дашборд" />
              </ListItemButton>
            )}
            {user?.role === 'super_admin' && (
              <>
                <ListItemButton component={RouterLink} to="/servers" selected={isActive('/servers')}>
                  <ListItemText primary="Серверы" />
                </ListItemButton>
                <ListItemButton component={RouterLink} to="/organizations" selected={isActive('/organizations')}>
                  <ListItemText primary="Клиенты" />
                </ListItemButton>
              </>
            )}
            {(user?.role === 'super_admin' || user?.role === 'engineer') && (
              <ListItemButton component={RouterLink} to="/bridge" selected={isActive('/bridge')}>
                <ListItemText primary="Мост" />
              </ListItemButton>
            )}
            {(user?.role === 'super_admin' || user?.role === 'org_admin') && (
              <ListItemButton component={RouterLink} to="/users" selected={isActive('/users')}>
                <ListItemText primary="Пользователи" />
              </ListItemButton>
            )}
          </List>
        </Box>
      </Drawer>
      <Container sx={{ mt: 4, mb: 4 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
