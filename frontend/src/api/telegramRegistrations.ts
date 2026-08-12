import { apiClient } from './client';
import { TelegramBroadcast, TelegramRegistration } from './types';

export async function fetchTelegramRegistrations(): Promise<TelegramRegistration[]> {
  const { data } = await apiClient.get<TelegramRegistration[]>('/telegram-registrations');
  return data;
}

export async function approveTelegramRegistration(id: string): Promise<void> {
  await apiClient.post(`/telegram-registrations/${id}/approve`);
}

export async function deleteTelegramRegistration(id: string): Promise<void> {
  await apiClient.delete(`/telegram-registrations/${id}`);
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
