import { apiClient } from './client';

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
