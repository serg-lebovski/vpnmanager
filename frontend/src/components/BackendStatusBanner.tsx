import { Alert } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { checkBackendHealth } from '../api/health';

const POLL_INTERVAL_MS = 4000;
const FAILURES_BEFORE_DOWN = 2;

// Глобальный баннер "backend недоступен" — виден на любой странице (монтируется в App.tsx
// над роутами, а не внутри DashboardLayout), в том числе на /login, потому что недоступность
// чаще всего проявляется как раз во время/сразу после самообновления (см. SettingsPage,
// update.service.ts), когда пользователь мог быть где угодно в приложении. Два подряд
// неудачных пинга перед показом — чтобы не мигать баннером на одиночный сетевой блип.
export function BackendStatusBanner() {
  const [down, setDown] = useState(false);
  const consecutiveFailures = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const ok = await checkBackendHealth();
      if (cancelled) return;
      if (ok) {
        consecutiveFailures.current = 0;
        setDown(false);
      } else {
        consecutiveFailures.current += 1;
        if (consecutiveFailures.current >= FAILURES_BEFORE_DOWN) {
          setDown(true);
        }
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!down) {
    return null;
  }

  return (
    <Alert severity="warning" square sx={{ justifyContent: 'center', position: 'sticky', top: 0, zIndex: 1300 }}>
      Backend недоступен — сервер не отвечает. Если недавно запускалось обновление, подождите
      пару минут: панель восстановится сама, как только backend перезапустится.
    </Alert>
  );
}
