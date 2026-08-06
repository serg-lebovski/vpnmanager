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

  const theme = useMemo(() => createTheme({ palette: { mode } }), [mode]);
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
