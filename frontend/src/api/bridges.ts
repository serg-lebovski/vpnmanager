import { apiClient } from './client';
import { BridgeEntity, BridgeUpstreamMode, VpnProtocol } from './types';

export async function fetchBridges(): Promise<BridgeEntity[]> {
  const { data } = await apiClient.get<BridgeEntity[]>('/bridges');
  return data;
}

export interface BridgeClientProtocolInput {
  protocol: VpnProtocol;
  listenPort: number;
  networkCidr: string;
}

export interface CreateBridgeInput {
  name: string;
  selfServerId: string;
  organizationId?: string;
  clientProtocols: BridgeClientProtocolInput[];
}

export async function createBridge(input: CreateBridgeInput): Promise<BridgeEntity> {
  const { data } = await apiClient.post<BridgeEntity>('/bridges', input);
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

export async function rebalanceBridge(bridgeId: string): Promise<BridgeEntity> {
  const { data } = await apiClient.post<BridgeEntity>(`/bridges/${bridgeId}/rebalance`);
  return data;
}
