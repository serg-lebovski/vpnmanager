import {
  AppBar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
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
import HistoryIcon from '@mui/icons-material/History';
import HubIcon from '@mui/icons-material/Hub';
import MenuIcon from '@mui/icons-material/Menu';
import DnsIcon from '@mui/icons-material/Dns';
import BusinessIcon from '@mui/icons-material/Business';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import PeopleIcon from '@mui/icons-material/People';
import SettingsIcon from '@mui/icons-material/Settings';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard';
import TelegramIcon from '@mui/icons-material/Telegram';
import { ComponentType, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useThemeMode } from '../theme/ThemeModeContext';

const roleLabels: Record<string, string> = {
  super_admin: 'Суперадмин',
  org_admin: 'Администратор организации',
  org_user: 'Пользователь',
  engineer: 'Инженер',
};

const DRAWER_WIDTH = 216;

interface NavItem {
  path: string;
  label: string;
  icon: ComponentType<{ fontSize?: 'small' }>;
  // Отсутствие roles — пункт виден всем аутентифицированным ролям (например, Peers).
  roles?: string[];
}

// Один источник правды для пунктов навигации — раньше тот же список (с теми же ролевыми
// условиями) дублировался отдельно для десктопного AppBar и мобильного Drawer, расходясь
// рисковал при любом будущем изменении пунктов меню.
const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Peers', icon: PeopleIcon },
  { path: '/dashboard', label: 'Дашборд', icon: SpaceDashboardIcon, roles: ['super_admin', 'engineer'] },
  { path: '/servers', label: 'Серверы', icon: DnsIcon, roles: ['super_admin'] },
  { path: '/bridge', label: 'Мост', icon: HubIcon, roles: ['super_admin', 'engineer'] },
  { path: '/organizations', label: 'Клиенты', icon: BusinessIcon, roles: ['super_admin'] },
  { path: '/telegram-bot', label: 'Telegram', icon: TelegramIcon, roles: ['super_admin'] },
  { path: '/users', label: 'Пользователи', icon: ManageAccountsIcon, roles: ['super_admin', 'org_admin'] },
];

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useThemeMode();
  const location = useLocation();
  const navigate = useNavigate();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const theme = useTheme();
  // Прежняя раскладка — горизонтальный ряд текстовых кнопок в AppBar — на десктопе у
  // суперадмина (7 пунктов меню) превращалась в сплошную полосу без иерархии, а под
  // "Настройки"/"Журнал действий" всё равно был отдельный выпадающий список. Постоянная
  // боковая панель слева — привычный паттерн админ-панелей: пункты с иконками читаются
  // быстрее построчно, чем в строку, и остаётся больше места под сам контент страницы.
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // "/" — только точное совпадение (иначе подсвечивался бы всегда, это префикс всех
  // путей); остальные вкладки — по префиксу, чтобы вложенные страницы (например,
  // /organizations/:id) тоже подсвечивали свой родительский пункт меню.
  function isActive(path: string): boolean {
    return path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  }

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role)));
  const activeItem = visibleItems.find((item) => isActive(item.path));

  const sidebarContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Toolbar sx={{ gap: 1 }}>
        <HubIcon color="primary" />
        <Typography variant="subtitle1" fontWeight={600} noWrap>
          VPN Manager
        </Typography>
      </Toolbar>
      <Divider />
      <List sx={{ flexGrow: 1, py: 1 }}>
        {visibleItems.map(({ path, label, icon: Icon }) => (
          <ListItemButton
            key={path}
            component={RouterLink}
            to={path}
            selected={isActive(path)}
            onClick={() => setDrawerOpen(false)}
            sx={{ mx: 1, borderRadius: 1, mb: 0.25 }}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={label} primaryTypographyProps={{ variant: 'body2' }} />
          </ListItemButton>
        ))}
      </List>
      <Divider />
      <Box sx={{ p: 1.5 }}>
        <Box
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', borderRadius: 1, p: 1, '&:hover': { bgcolor: 'action.hover' } }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap title={user?.email}>
              {user?.email}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {user ? roleLabels[user.role] : ''}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      {isMobile ? (
        <Drawer anchor="left" open={drawerOpen} onClose={() => setDrawerOpen(false)} sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}>
          {sidebarContent}
        </Drawer>
      ) : (
        <Box
          component="nav"
          sx={{ width: DRAWER_WIDTH, flexShrink: 0, borderRight: 1, borderColor: 'divider', bgcolor: 'background.paper' }}
        >
          {sidebarContent}
        </Box>
      )}

      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar sx={{ gap: 1 }}>
            {isMobile && (
              <IconButton edge="start" aria-label="Меню" onClick={() => setDrawerOpen(true)}>
                <MenuIcon />
              </IconButton>
            )}
            <Typography variant="subtitle1" sx={{ flexGrow: 1 }} noWrap>
              {activeItem?.label ?? 'VPN Manager'}
            </Typography>
            <Tooltip title={mode === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
              <IconButton onClick={toggleMode} size="small">
                {mode === 'dark' ? <Brightness7Icon fontSize="small" /> : <Brightness4Icon fontSize="small" />}
              </IconButton>
            </Tooltip>
            {user?.role === 'super_admin' && (
              <>
                <Tooltip title="Настройки">
                  <IconButton component={RouterLink} to="/settings" size="small">
                    <SettingsIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Журнал действий">
                  <IconButton component={RouterLink} to="/audit-log" size="small">
                    <HistoryIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </>
            )}
          </Toolbar>
        </AppBar>
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              logout();
            }}
          >
            Выйти
          </MenuItem>
        </Menu>
        <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
