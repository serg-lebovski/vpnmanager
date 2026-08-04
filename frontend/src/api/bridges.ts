import { apiClient } from './client';
import { BridgeEntity, BridgeUpstreamMode, SshAuthType, VpnProtocol } from './types';

export async function fetchBridges(): Promise<BridgeEntity[]> {
  const { data } = await apiClient.get<BridgeEntity[]>('/bridges');
  return data;
}

export interface BridgeClientProtocolInput {
  protocol: VpnProtocol;
  listenPort: number;
  networkCidr: string;
}

export interface SelfServerCredentialsInput {
  host: string;
  sshPort?: number;
  sshUsername?: string;
  sshAuthType: SshAuthType;
  secret: string;
}

export interface CreateBridgeInput {
  name: string;
  // Нужен только для самого первого моста в системе — дальше self-сервер уже существует
  // и переиспользуется автоматически, поле игнорируется.
  selfServerCredentials?: SelfServerCredentialsInput;
  organizationId?: string;
  clientProtocols: BridgeClientProtocolInput[];
}

export async function createBridge(input: CreateBridgeInput): Promise<BridgeEntity> {
  const { data } = await apiClient.post<BridgeEntity>('/bridges', input);
  return data;
}

export interface UpdateBridgeInput {
  name?: string;
  organizationId?: string | null;
  domainName?: string | null;
}

export async function updateBridge(bridgeId: string, input: UpdateBridgeInput): Promise<BridgeEntity> {
  const { data } = await apiClient.patch<BridgeEntity>(`/bridges/${bridgeId}`, input);
  return data;
}

export async function setBridgeUpstream(bridgeId: string, serverProtocolId: string): Promise<BridgeEntity> {
  const { data } = await apiClient.post<BridgeEntity>(`/bridges/${bridgeId}/upstream`, { serverProtocolId });
  return data;
}

export async function setBridgeMode(bridgeId: string, mode: BridgeUpstreamMode): Promise<BridgeEntity> {
  const { data } = await apiClient.post<BridgeEntity>(`/bridges/${bridgeId}/mode`, { mode });
  return data;
}

// Порядок serverProtocolIds = приоритет (индекс 0 — основной сервер).
export async function setUpstreamCandidates(bridgeId: string, serverProtocolIds: string[]): Promise<BridgeEntity> {
  const { data } = await apiClient.put<BridgeEntity>(`/bridges/${bridgeId}/upstream-candidates`, { serverProtocolIds });
  return data;
}

export async function fetchCandidateStatus(bridgeId: string): Promise<Record<string, boolean | null>> {
  const { data } = await apiClient.get<Record<string, boolean | null>>(`/bridges/${bridgeId}/candidate-status`);
  return data;
}

export async function rebalanceBridge(bridgeId: string): Promise<BridgeEntity> {
  const { data } = await apiClient.post<BridgeEntity>(`/bridges/${bridgeId}/rebalance`);
  return data;
}

export async function deleteBridge(bridgeId: string): Promise<void> {
  await apiClient.delete(`/bridges/${bridgeId}`);
}
