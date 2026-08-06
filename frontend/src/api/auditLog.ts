import { apiClient } from './client';

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  method: string;
  path: string;
  targetId: string | null;
  body: Record<string, unknown> | null;
  statusCode: number;
  ipAddress: string | null;
  createdAt: string;
}

export async function fetchAuditLog(limit = 200): Promise<AuditLogEntry[]> {
  const { data } = await apiClient.get<AuditLogEntry[]>('/audit-log', { params: { limit } });
  return data;
}
