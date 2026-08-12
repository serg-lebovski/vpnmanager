import { apiClient } from './client';
import { TelegramRegistration } from './types';

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

export async function broadcastTelegramMessage(text: string): Promise<{ sent: number; failed: number }> {
  const { data } = await apiClient.post<{ sent: number; failed: number }>('/telegram-registrations/broadcast', { text });
  return data;
}
