import axios from 'axios';
import { VpnProtocol } from './types';

export function getErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string | string[] } | undefined;
    if (data?.message) {
      return Array.isArray(data.message) ? data.message.join(', ') : data.message;
    }
  }
  return fallback;
}

export interface KernelRebootRequiredInfo {
  message: string;
  serverId: string;
  serverName: string;
  protocol: VpnProtocol;
}

// Структурированная ошибка от VpnProvisioningService.checkKernelModuleReadiness —
// модуль протокола на сервере собран не под текущее ядро, нужна перезагрузка сервера.
// Отличается от обычной ошибки установки/подключения тем, что требует явного
// подтверждения администратора (см. KernelRebootConfirmDialog), а не просто текста ошибки.
export function getKernelRebootInfo(error: unknown): KernelRebootRequiredInfo | null {
  if (!axios.isAxiosError(error)) {
    return null;
  }
  const data = error.response?.data as Partial<KernelRebootRequiredInfo> & { code?: string } | undefined;
  if (data?.code !== 'KERNEL_REBOOT_REQUIRED' || !data.serverId || !data.serverName || !data.protocol || !data.message) {
    return null;
  }
  return { message: data.message, serverId: data.serverId, serverName: data.serverName, protocol: data.protocol };
}
