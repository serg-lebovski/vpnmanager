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

  // Компактные дефолты для полей/кнопок/таблиц — раньше в разметке size="small" расставляли
  // вручную на каждом TextField/Button отдельно (где-то забывали, из-за этого плотность
  // "гуляла" от страницы к странице); теперь это дефолт темы — локальный size="small" в
  // разметке страниц всё так же работает (явный проп всегда переопределяет тему), просто
  // больше не обязателен для единообразной компактности.
  const theme = useMemo(
    () =>
      createTheme({
        palette: { mode },
        components: {
          MuiTextField: { defaultProps: { size: 'small' } },
          MuiButton: { defaultProps: { size: 'small' } },
          MuiIconButton: { defaultProps: { size: 'small' } },
          MuiSelect: { defaultProps: { size: 'small' } },
          MuiFormControl: { defaultProps: { size: 'small' } },
          MuiChip: { defaultProps: { size: 'small' } },
          MuiTableCell: { styleOverrides: { root: { paddingTop: 6, paddingBottom: 6 } } },
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
