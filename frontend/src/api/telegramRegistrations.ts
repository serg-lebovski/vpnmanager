import { apiClient } from './client';
import { TelegramBotLogEntry, TelegramBroadcast, TelegramRegistration } from './types';

export async function fetchTelegramRegistrations(): Promise<TelegramRegistration[]> {
  const { data } = await apiClient.get<TelegramRegistration[]>('/telegram-registrations');
  return data;
}

export async function approveTelegramRegistration(id: string): Promise<void> {
  await apiClient.post(`/telegram-registrations/${id}/approve`);
}

export async function deleteTelegramRegistration(id: string, revokePeers: boolean): Promise<void> {
  await apiClient.delete(`/telegram-registrations/${id}`, { params: { revokePeers } });
}

export async function broadcastTelegramMessage(text: string, pin: boolean): Promise<{ sent: number; failed: number }> {
  const { data } = await apiClient.post<{ sent: number; failed: number }>('/telegram-registrations/broadcast', { text, pin });
  return data;
}

export async function fetchTelegramBroadcasts(): Promise<TelegramBroadcast[]> {
  const { data } = await apiClient.get<TelegramBroadcast[]>('/telegram-registrations/broadcasts');
  return data;
}

export async function deleteTelegramBroadcast(id: string): Promise<void> {
  await apiClient.delete(`/telegram-registrations/broadcasts/${id}`);
}

export async function fetchTelegramBotLogs(): Promise<TelegramBotLogEntry[]> {
  const { data } = await apiClient.get<TelegramBotLogEntry[]>('/telegram-registrations/logs');
  return data;
}

// webToken — генерируется лениво на бэкенде при первом запросе; полный URL собираем здесь
// из текущего origin панели (бэкенд не обязан знать, по какому домену/IP она сейчас
// доступна снаружи).
export async function fetchTelegramPortalLink(id: string): Promise<string> {
  const { data } = await apiClient.get<{ webToken: string }>(`/telegram-registrations/${id}/portal-link`);
  return `${window.location.origin}/portal/${data.webToken}`;
}
