import {
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
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import DnsIcon from '@mui/icons-material/Dns';
import BusinessIcon from '@mui/icons-material/Business';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import PeopleIcon from '@mui/icons-material/People';
import SettingsIcon from '@mui/icons-material/Settings';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard';
import TelegramIcon from '@mui/icons-material/Telegram';
import { ComponentType, useEffect, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { checkBackendHealth } from '../api/health';
import { useAuth } from '../auth/AuthContext';
import { useThemeMode } from '../theme/ThemeModeContext';

const roleLabels: Record<string, string> = {
  super_admin: 'Суперадмин',
  org_admin: 'Администратор организации',
  org_user: 'Пользователь',
  engineer: 'Инженер',
};

const DRAWER_WIDTH = 240;
const STATUS_POLL_MS = 15_000;

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

// Отдельные от основной навигации — служебные разделы, в самом низу панели (тот же
// паттерн, что и в референсе: "Настройки"/"Партнёрка" отдельным блоком под основным меню).
const FOOTER_ITEMS: NavItem[] = [
  { path: '/settings', label: 'Настройки', icon: SettingsIcon, roles: ['super_admin'] },
  { path: '/audit-log', label: 'Журнал действий', icon: HistoryIcon, roles: ['super_admin'] },
];

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        bgcolor: ok ? 'success.main' : 'error.main',
        boxShadow: ok ? '0 0 6px' : 'none',
        flexShrink: 0,
      }}
    />
  );
}

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useThemeMode();
  const location = useLocation();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const theme = useTheme();
  // Прежняя раскладка — горизонтальный ряд текстовых кнопок в AppBar — на десктопе у
  // суперадмина (7 пунктов меню) превращалась в сплошную полосу без иерархии. Постоянная
  // боковая панель слева — привычный паттерн админ-панелей (взят за образец по просьбе
  // пользователя — тёмная тема, карточка профиля в сайдбаре, статус-индикатор сверху).
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Лёгкий опрос доступности backend прямо для статус-индикатора в шапке ("ВСЕ СИСТЕМЫ
  // РАБОТАЮТ" / недоступен) — отдельно от BackendStatusBanner (тот монтируется в App.tsx
  // над роутами и показывает ПРЕДУПРЕЖДЕНИЕ только когда backend реально упал; этот
  // индикатор, наоборот, всегда виден и в норме показывает позитивный статус).
  const [backendOk, setBackendOk] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const ok = await checkBackendHealth();
      if (!cancelled) setBackendOk(ok);
    }
    poll();
    const interval = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // "/" — только точное совпадение (иначе подсвечивался бы всегда, это префикс всех
  // путей); остальные вкладки — по префиксу, чтобы вложенные страницы (например,
  // /organizations/:id) тоже подсвечивали свой родительский пункт меню.
  function isActive(path: string): boolean {
    return path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  }

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role)));
  const visibleFooterItems = FOOTER_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role)));
  const activeItem = [...visibleItems, ...visibleFooterItems].find((item) => isActive(item.path));

  const initial = user?.email?.[0]?.toUpperCase() ?? '?';

  function renderNavButton({ path, label, icon: Icon }: NavItem) {
    return (
      <ListItemButton
        key={path}
        component={RouterLink}
        to={path}
        selected={isActive(path)}
        onClick={() => setDrawerOpen(false)}
        sx={{ mx: 1, borderRadius: 2, mb: 0.25 }}
      >
        <ListItemIcon sx={{ minWidth: 36 }}>
          <Icon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={label} primaryTypographyProps={{ variant: 'body2' }} />
      </ListItemButton>
    );
  }

  const sidebarContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Toolbar sx={{ gap: 1 }}>
        <StatusDot ok={backendOk} />
        <Typography variant="subtitle1" fontWeight={700} letterSpacing={0.5} noWrap>
          VPN MANAGER
        </Typography>
      </Toolbar>
      <Divider />

      <Box sx={{ p: 1.5 }}>
        <Box
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            cursor: 'pointer',
            borderRadius: 2,
            p: 1,
            bgcolor: 'action.hover',
          }}
        >
          <Box
            sx={{
              width: 36,
              height: 36,
              borderRadius: 1.5,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {initial}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap title={user?.email}>
              {user?.email}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {user ? roleLabels[user.role] : ''}
            </Typography>
          </Box>
        </Box>
      </Box>

      <Typography variant="caption" color="text.secondary" fontWeight={700} letterSpacing={0.8} sx={{ px: 2.5, mt: 1, mb: 0.5 }}>
        РАЗДЕЛЫ
      </Typography>
      <List sx={{ flexGrow: 1, py: 0 }}>{visibleItems.map(renderNavButton)}</List>

      {visibleFooterItems.length > 0 && (
        <>
          <Divider sx={{ mx: 1.5 }} />
          <List sx={{ py: 1 }}>{visibleFooterItems.map(renderNavButton)}</List>
        </>
      )}
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
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            // Без этого сайдбар растягивался на высоту ВСЕГО flex-контейнера (по умолчанию
            // align-items: stretch), а она равна высоте самой длинной страницы справа —
            // на страницах с большой таблицей (Peers, Мост) нижние пункты меню
            // ("Настройки", "Журнал действий") уезжали на тысячи пикселей вниз за пределы
            // видимой области вместо того, чтобы остаться закреплёнными на экране.
            // Пойманный вживую случай: пользователь физически не мог "попасть в
            // настройки" — пункт существовал в DOM, но визуально был недостижим без
            // прокрутки всей страницы до конца.
            position: 'sticky',
            top: 0,
            height: '100vh',
            overflowY: 'auto',
          }}
        >
          {sidebarContent}
        </Box>
      )}

      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Toolbar sx={{ gap: 1.5, borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, bgcolor: 'background.default', zIndex: 1 }}>
          {isMobile && (
            <IconButton edge="start" aria-label="Меню" onClick={() => setDrawerOpen(true)}>
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }} noWrap>
            {activeItem?.label ?? 'VPN Manager'}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: backendOk ? 'success.main' : 'error.main' }}>
            <StatusDot ok={backendOk} />
            <Typography variant="caption" fontWeight={700} letterSpacing={0.4} sx={{ display: { xs: 'none', sm: 'block' } }}>
              {backendOk ? 'ВСЕ СИСТЕМЫ РАБОТАЮТ' : 'BACKEND НЕДОСТУПЕН'}
            </Typography>
          </Box>
          <Tooltip title={mode === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            <IconButton onClick={toggleMode} size="small">
              {mode === 'dark' ? <Brightness7Icon fontSize="small" /> : <Brightness4Icon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Toolbar>
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              logout();
            }}
          >
            <ListItemIcon>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
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
