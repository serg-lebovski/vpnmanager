import { apiClient } from './client';

export interface SystemSettings {
  id: number;
  domain: string | null;
  letsEncryptEmail: string | null;
  httpEnabled: boolean;
  httpsEnabled: boolean;
  certExpiresAt: string | null;
  lastCertError: string | null;
  telegramEnabled: boolean;
  telegramChatId: string | null;
  telegramBridgeId: string | null;
  telegramWelcomeMessage: string | null;
  updatedAt: string;
}

export async function fetchSettings(): Promise<SystemSettings> {
  const { data } = await apiClient.get<SystemSettings>('/system/settings');
  return data;
}

export interface UpdateSettingsInput {
  domain?: string;
  letsEncryptEmail?: string;
  httpEnabled?: boolean;
  httpsEnabled?: boolean;
  telegramEnabled?: boolean;
  // Отсутствие поля — не менять сохранённый токен.
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramBridgeId?: string | null;
  telegramWelcomeMessage?: string;
}

export async function updateSettings(input: UpdateSettingsInput): Promise<SystemSettings> {
  const { data } = await apiClient.patch<SystemSettings>('/system/settings', input);
  return data;
}

export async function renewCertificate(force: boolean): Promise<SystemSettings> {
  const { data } = await apiClient.post<SystemSettings>('/system/certificate/renew', { force });
  return data;
}

export async function sendTestTelegramMessage(): Promise<{ message: string }> {
  const { data } = await apiClient.post<{ message: string }>('/system/telegram/test');
  return data;
}
