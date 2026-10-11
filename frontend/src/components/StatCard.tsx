import { Box, Paper, Stack, Typography } from '@mui/material';
import { ReactNode } from 'react';

// Карточка-метрика для сводок (Дашборд, Peers, Серверы) — тот же паттерн, что в референсе
// панели хостинг-провайдера: мелкий uppercase-лейбл + крупное число. Один компонент вместо
// копирования разметки на каждой странице со своей сводкой.
export function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: ReactNode;
  color?: 'success.main' | 'warning.main' | 'error.main' | 'text.primary';
  icon?: ReactNode;
}) {
  return (
    <Paper sx={{ p: 2, flex: '1 1 160px', minWidth: 160 }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between">
        <Box>
          <Typography variant="caption" color="text.secondary" fontWeight={700} letterSpacing={0.6}>
            {label.toUpperCase()}
          </Typography>
          <Typography variant="h4" fontWeight={700} color={color ?? 'text.primary'} sx={{ mt: 0.5 }}>
            {value}
          </Typography>
        </Box>
        {icon && (
          <Box sx={{ color: 'text.secondary', opacity: 0.6 }}>{icon}</Box>
        )}
      </Stack>
    </Paper>
  );
}
