import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'vpnmanager-theme-mode';

interface ThemeModeContextValue {
  mode: ThemeMode;
  toggleMode: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | undefined>(undefined);

// Без сохранённого выбора (первый визит) — подстраиваемся под системную тему ОС/браузера,
// а не жёстко под light.
function readInitialMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  // Палитра/форма подогнаны под референс панели хостинг-провайдера, который попросил
  // взять за основу пользователь: очень тёмный фон, карточки на тон светлее БЕЗ тени (вместо
  // неё — тонкая граница divider-цветом), крупное скругление, зелёный акцент (статус "всё
  // работает"/активные состояния). Светлая тема — та же форма/скругления, но без попытки
  // предположить "светлую версию" чужого референса — обычная MUI-палитра поверх той же shape.
  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode,
          ...(mode === 'dark'
            ? {
                primary: { main: '#22c55e', contrastText: '#06120a' },
                background: { default: '#0b0d12', paper: '#14171f' },
                divider: 'rgba(255,255,255,0.09)',
                text: { primary: '#e8eaf0', secondary: '#8b93a7' },
              }
            : {
                primary: { main: '#16a34a' },
                background: { default: '#f3f4f7', paper: '#ffffff' },
              }),
        },
        shape: { borderRadius: 12 },
        components: {
          MuiTextField: { defaultProps: { size: 'small' } },
          MuiButton: { defaultProps: { size: 'small' }, styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
          MuiIconButton: { defaultProps: { size: 'small' } },
          MuiSelect: { defaultProps: { size: 'small' } },
          MuiFormControl: { defaultProps: { size: 'small' } },
          MuiChip: { defaultProps: { size: 'small' }, styleOverrides: { root: { borderRadius: 999, fontWeight: 600 } } },
          MuiTableCell: { styleOverrides: { root: { paddingTop: 6, paddingBottom: 6 } } },
          // Плоские карточки с тонкой границей вместо тени — тень на почти-чёрном фоне
          // плохо читается и визуально "грязнит" интерфейс; тень оставляем только для
          // по-настоящему приподнятых поверхностей (диалоги, меню — обычно elevation > 2).
          MuiPaper: {
            styleOverrides: {
              root: ({ theme: t, ownerState }) => ({
                backgroundImage: 'none',
                ...((ownerState.elevation ?? 0) <= 2 && {
                  boxShadow: 'none',
                  border: `1px solid ${t.palette.divider}`,
                }),
              }),
            },
          },
          MuiAppBar: { styleOverrides: { root: { backgroundImage: 'none' } } },
        },
      }),
    [mode],
  );
  const value = useMemo<ThemeModeContextValue>(
    () => ({ mode, toggleMode: () => setMode((prev) => (prev === 'light' ? 'dark' : 'light')) }),
    [mode],
  );

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode должен использоваться внутри ThemeModeProvider');
  }
  return ctx;
}
