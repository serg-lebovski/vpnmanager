import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { connectTerminalSocket } from '../api/terminal';

// Веб-терминал SSH к серверу прямо из панели (см. backend/src/terminal/) — SUPER_ADMIN-only,
// открывается по кнопке на карточке сервера (ServersPage.tsx). xterm.js рендерит настоящий
// интерактивный терминал (цвета, курсор, control-последовательности); ResizeObserver вместо
// window 'resize' — у MUI Dialog размер контейнера меняется при открытии/анимации без
// события resize окна.
export function TerminalDialog({ serverId, serverLabel, onClose }: { serverId: string; serverLabel: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error' | 'closed'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const term = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 13, theme: { background: '#000000' } });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const socket = connectTerminalSocket();

    socket.on('connect', () => {
      socket.emit('start', { serverId, cols: term.cols, rows: term.rows });
    });
    socket.on('ready', () => setStatus('ready'));
    socket.on('data', (chunk: string) => term.write(chunk));
    socket.on('error', (message: string) => {
      setStatus('error');
      setErrorMessage(message);
    });
    socket.on('closed', () => setStatus('closed'));
    socket.on('disconnect', () => setStatus((prev) => (prev === 'error' ? prev : 'closed')));

    const inputDisposable = term.onData((data) => socket.emit('input', data));

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (socket.connected) {
        socket.emit('resize', { cols: term.cols, rows: term.rows });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      socket.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  return (
    <Dialog open fullWidth maxWidth="lg" onClose={onClose}>
      <DialogTitle>Терминал: {serverLabel}</DialogTitle>
      <DialogContent sx={{ p: 0 }}>
        {status === 'connecting' && (
          <Alert severity="info" sx={{ borderRadius: 0 }}>
            Подключение…
          </Alert>
        )}
        {status === 'error' && (
          <Alert severity="error" sx={{ borderRadius: 0 }}>
            {errorMessage}
          </Alert>
        )}
        {status === 'closed' && (
          <Alert severity="warning" sx={{ borderRadius: 0 }}>
            Сессия завершена
          </Alert>
        )}
        <Box ref={containerRef} sx={{ height: 480, bgcolor: '#000', p: 1 }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрыть</Button>
      </DialogActions>
    </Dialog>
  );
}
