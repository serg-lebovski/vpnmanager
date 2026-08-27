import { apiClient } from './client';
import { PeerEntity, VpnProtocol } from './types';

export async function fetchPeers(organizationId?: string): Promise<PeerEntity[]> {
  const { data } = await apiClient.get<PeerEntity[]>('/peers', {
    params: organizationId ? { organizationId } : undefined,
  });
  return data;
}

// Для формы создания peer — доступные напрямую (в обход моста) серверы; в отличие от
// /servers (super_admin-only), доступен всем ролям, сервис сам скоупит по организации.
export async function fetchAllowedServers(): Promise<Array<{ id: string; name: string }>> {
  const { data } = await apiClient.get<Array<{ id: string; name: string }>>('/peers/allowed-servers');
  return data;
}

export interface CreatePeerInput {
  protocol: VpnProtocol;
  name: string;
  serverId?: string;
  bridgeId?: string;
  // null — явное «без клиента» (только для super_admin); undefined — не передавать
  // (org_admin/org_user всегда создают peer в своей организации на бэкенде).
  organizationId?: string | null;
  // Мультиконфиг — создать сразу пару peer'ов (WireGuard + AmneziaWG) на выбранном мосту/
  // сервере, выдаётся одним .vpn-файлом для приложения AmneziaVPN (protocol в этом случае
  // игнорируется бэкендом). Требует, чтобы ОБА протокола были активны на выбранном мосту/
  // сервере — иначе 400.
  multiProtocol?: boolean;
}

export async function createPeer(input: CreatePeerInput): Promise<PeerEntity> {
  const { data } = await apiClient.post<PeerEntity>('/peers', input);
  return data;
}

export interface UpdatePeerInput {
  name?: string;
  // Смена организации — только для super_admin (проверяется на бэкенде).
  organizationId?: string | null;
  // Срок действия ("подписка") — тоже только для super_admin. null — сделать бессрочным.
  expiresAt?: string | null;
}

export async function updatePeer(id: string, input: UpdatePeerInput): Promise<PeerEntity> {
  const { data } = await apiClient.patch<PeerEntity>(`/peers/${id}`, input);
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

// Дополнительный формат — .vpn для официального приложения AmneziaVPN (не заменяет
// downloadPeerConfig/.conf). Работает для любого peer'а: для пары мультиконфига в файл
// попадают оба протокола, для обычного peer'а — один (просто без переключения в приложении).
export async function downloadPeerAmneziaConfig(id: string, suggestedName: string): Promise<void> {
  const response = await apiClient.get(`/peers/${id}/amnezia-config`, { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${suggestedName}.vpn`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function fetchPeerAmneziaQrCodeUrl(id: string): Promise<string> {
  const response = await apiClient.get(`/peers/${id}/amnezia-qrcode`, { responseType: 'blob' });
  return URL.createObjectURL(response.data);
}
