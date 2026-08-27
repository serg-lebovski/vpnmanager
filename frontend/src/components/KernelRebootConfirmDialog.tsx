import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { rebootForKernelModule } from '../api/servers';
import { getErrorMessage, KernelRebootRequiredInfo } from '../api/errors';

// Показывается, когда установка протокола/подключение upstream моста упёрлись в
// KERNEL_REBOOT_REQUIRED (см. VpnProvisioningService.checkKernelModuleReadiness) — DKMS-
// модуль протокола собран не под текущее загруженное ядро сервера, чинится только
// перезагрузкой ВСЕГО сервера. Перезагрузка больше не выполняется автоматически — требует
// явного подтверждения, так как прерывает все активные подключения на сервере на 30-90с.
export function KernelRebootConfirmDialog({
  info,
  onClose,
  onRebooted,
}: {
  info: KernelRebootRequiredInfo;
  onClose: () => void;
  onRebooted: () => void;
}) {
  const rebootMutation = useMutation({
    mutationFn: () => rebootForKernelModule(info.serverId, info.protocol),
    onSuccess: () => {
      onRebooted();
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Требуется перезагрузка сервера</DialogTitle>
      <DialogContent>
        <DialogContentText>{info.message}</DialogContentText>
        {rebootMutation.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {getErrorMessage(rebootMutation.error, 'Не удалось перезагрузить сервер')}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={rebootMutation.isPending}>
          Отмена
        </Button>
        <Button
          color="warning"
          variant="contained"
          onClick={() => rebootMutation.mutate()}
          disabled={rebootMutation.isPending}
        >
          {rebootMutation.isPending ? 'Перезагрузка…' : 'Перезагрузить и повторить'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
