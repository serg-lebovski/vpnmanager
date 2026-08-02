import { apiClient } from './client';
import { PeerEntity, VpnProtocol } from './types';

export async function fetchPeers(organizationId?: string): Promise<PeerEntity[]> {
  const { data } = await apiClient.get<PeerEntity[]>('/peers', {
    params: organizationId ? { organizationId } : undefined,
  });
  return data;
}

export interface CreatePeerInput {
  protocol: VpnProtocol;
  name: string;
  serverId?: string;
  bridgeId?: string;
  organizationId?: string;
}

export async function createPeer(input: CreatePeerInput): Promise<PeerEntity> {
  const { data } = await apiClient.post<PeerEntity>('/peers', input);
  return data;
}

export async function revokePeer(id: string): Promise<void> {
  await apiClient.delete(`/peers/${id}`);
}

// Безвозвратное удаление — только для уже отозванных peers.
export async function purgePeer(id: string): Promise<void> {
  await apiClient.delete(`/peers/${id}/purge`);
}

export async function downloadPeerConfig(id: string, suggestedName: string): Promise<void> {
  const response = await apiClient.get(`/peers/${id}/config`, { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${suggestedName}.conf`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function fetchPeerQrCodeUrl(id: string): Promise<string> {
  const response = await apiClient.get(`/peers/${id}/qrcode`, { responseType: 'blob' });
  return URL.createObjectURL(response.data);
}
