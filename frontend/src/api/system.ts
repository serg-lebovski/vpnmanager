import { io, Socket } from 'socket.io-client';
import { tokenStorage } from '../auth/tokenStorage';
import { apiClient } from './client';

export interface UpdateProgress {
  percent: number;
  step: string;
  done: boolean;
  error?: string;
}

// Namespace 'system' (backend/src/system/system.gateway.ts) — прогресс самообновления.
// Последний шаг (пересоздание backend) неизбежно рвёт это же соединение — это ожидаемо,
// не ошибка, см. обработку disconnect в SettingsPage.
export function connectUpdateProgressSocket(onProgress: (progress: UpdateProgress) => void): Socket {
  const socket = io('/system', {
    path: '/socket.io',
    auth: { token: tokenStorage.getAccessToken() },
  });
  socket.on('update-progress', onProgress);
  return socket;
}

export interface VersionInfo {
  currentCommit: string;
  currentCommitShort: string;
  remoteCommit: string | null;
  remoteCommitShort: string | null;
  updateAvailable: boolean;
  checkedAt: string;
}

export async function fetchVersion(): Promise<VersionInfo> {
  const { data } = await apiClient.get<VersionInfo>('/system/version');
  return data;
}

export async function triggerUpdate(): Promise<{ message: string }> {
  const { data } = await apiClient.post<{ message: string }>('/system/update');
  return data;
}

export type LogService = 'backend' | 'frontend' | 'nginx' | 'postgres';

export async function fetchLogs(service: LogService, tail: number): Promise<string> {
  const { data } = await apiClient.get<{ logs: string }>('/system/logs', { params: { service, tail } });
  return data.logs;
}

export async function downloadLogs(service: LogService): Promise<void> {
  const response = await apiClient.get('/system/logs/download', { params: { service, tail: 2000 }, responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  const disposition = (response.headers as Record<string, string>)['content-disposition'];
  const match = disposition?.match(/filename="(.+)"/);
  link.download = match?.[1] ?? `${service}.log`;
  link.click();
  URL.revokeObjectURL(url);
}

// Namespace 'system', тот же прогресс-паттерн, что у самообновления — RestoreService в
// конце тоже намеренно рвёт это соединение (process.exit()), обработка disconnect в
// SettingsPage переиспользует тот же waitingForBackend-паттерн для обоих событий.
export function connectRestoreProgressSocket(onProgress: (progress: UpdateProgress) => void): Socket {
  const socket = io('/system', {
    path: '/socket.io',
    auth: { token: tokenStorage.getAccessToken() },
  });
  socket.on('restore-progress', onProgress);
  return socket;
}

export async function restoreDatabase(file: File, confirmationPhrase: string): Promise<{ message: string }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('confirmationPhrase', confirmationPhrase);
  const { data } = await apiClient.post<{ message: string }>('/system/restore', formData);
  return data;
}

export async function downloadDatabaseBackup(): Promise<void> {
  const response = await apiClient.get('/system/backup', { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  const disposition = (response.headers as Record<string, string>)['content-disposition'];
  const match = disposition?.match(/filename="(.+)"/);
  link.download = match?.[1] ?? 'backup.sql';
  link.click();
  URL.revokeObjectURL(url);
}

// Отдельный файл, не часть бэкапа — см. backend/backup.service.ts#downloadEncryptionKey.
export async function downloadEncryptionKey(): Promise<void> {
  const response = await apiClient.get('/system/backup/encryption-key', { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  const disposition = (response.headers as Record<string, string>)['content-disposition'];
  const match = disposition?.match(/filename="(.+)"/);
  link.download = match?.[1] ?? 'encryption-key.txt';
  link.click();
  URL.revokeObjectURL(url);
}
