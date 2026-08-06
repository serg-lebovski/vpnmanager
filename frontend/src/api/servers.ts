import { apiClient } from './client';
import { ServerEntity, SshAuthType, VpnProtocol } from './types';

export async function fetchServers(): Promise<ServerEntity[]> {
  const { data } = await apiClient.get<ServerEntity[]>('/servers');
  return data;
}

export interface CreateServerInput {
  name: string;
  host: string;
  sshPort?: number;
  sshUsername: string;
  sshAuthType: SshAuthType;
  secret: string;
  maxPeers?: number;
}

export async function createServer(input: CreateServerInput): Promise<ServerEntity> {
  const { data } = await apiClient.post<ServerEntity>('/servers', input);
  return data;
}

export async function updateServer(id: string, input: { name: string }): Promise<ServerEntity> {
  const { data } = await apiClient.patch<ServerEntity>(`/servers/${id}`, input);
  return data;
}

export interface UpdateServerCredentialsInput {
  sshUsername?: string;
  sshPort?: number;
  sshAuthType?: SshAuthType;
  secret: string;
}

export async function updateServerCredentials(id: string, input: UpdateServerCredentialsInput): Promise<ServerEntity> {
  const { data } = await apiClient.patch<ServerEntity>(`/servers/${id}/credentials`, input);
  return data;
}

export async function deleteServer(id: string): Promise<void> {
  await apiClient.delete(`/servers/${id}`);
}

export async function testServerConnection(id: string): Promise<{ ok: boolean; info?: string; error?: string }> {
  const { data } = await apiClient.post(`/servers/${id}/test-connection`);
  return data;
}

export async function rebootServer(id: string): Promise<{ message: string }> {
  const { data } = await apiClient.post(`/servers/${id}/reboot`);
  return data;
}

export interface InstallProtocolInput {
  protocol: VpnProtocol;
  listenPort: number;
  networkCidr: string;
}

export async function installProtocol(serverId: string, input: InstallProtocolInput) {
  const { data } = await apiClient.post(`/servers/${serverId}/protocols`, input);
  return data;
}

export async function scanAndImportPeers(serverProtocolId: string): Promise<{ importedCount: number }> {
  const { data } = await apiClient.post(`/servers/protocols/${serverProtocolId}/scan`);
  return data;
}

// В отличие от deleteServer — реально снимает интерфейс на сервере (down/автозапуск/
// конфиг/ключи), а не только запись в БД.
export async function deleteProtocol(serverProtocolId: string): Promise<void> {
  await apiClient.delete(`/servers/protocols/${serverProtocolId}`);
}

export async function checkProtocolVersion(serverProtocolId: string) {
  const { data } = await apiClient.post(`/servers/protocols/${serverProtocolId}/check-version`);
  return data;
}

export async function updateProtocolPackage(serverProtocolId: string) {
  const { data } = await apiClient.post(`/servers/protocols/${serverProtocolId}/update-package`);
  return data;
}

export interface DetectionResult {
  protocol: VpnProtocol;
  found: boolean;
  importedCount?: number;
}

export async function detectExistingInstallations(serverId: string): Promise<DetectionResult[]> {
  const { data } = await apiClient.post(`/servers/${serverId}/detect`);
  return data;
}
