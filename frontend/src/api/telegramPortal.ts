import { portalClient } from './portalClient';
import { PeerDeviceType, TelegramRegistrationStatus, VpnProtocol } from './types';

export interface PortalDevice {
  deviceType: PeerDeviceType;
  createdAt: string;
}

export interface PortalStatus {
  fullName: string;
  organizationName: string;
  status: TelegramRegistrationStatus;
  linkedToTelegram: boolean;
  devices: PortalDevice[];
  botDeepLink: string | null;
}

export interface PortalUpstreamOption {
  key: string;
  label: string;
}

export interface PortalConfigResult {
  filename: string;
  content: string;
  qrDataUri: string;
}

export async function registerPortal(orgQuery: string, fullName: string): Promise<{ webToken: string }> {
  const { data } = await portalClient.post<{ webToken: string }>('/telegram-portal/register', { orgQuery, fullName });
  return data;
}

export async function fetchPortalStatus(token: string): Promise<PortalStatus> {
  const { data } = await portalClient.get<PortalStatus>(`/telegram-portal/${token}`);
  return data;
}

export async function fetchPortalUpstreamOptions(token: string, protocol: VpnProtocol): Promise<PortalUpstreamOption[]> {
  const { data } = await portalClient.get<PortalUpstreamOption[]>(`/telegram-portal/${token}/upstream-options`, { params: { protocol } });
  return data;
}

export async function issuePortalConfig(
  token: string,
  input: { deviceType: PeerDeviceType; protocol: VpnProtocol; upstreamKey?: string },
): Promise<PortalConfigResult> {
  const { data } = await portalClient.post<PortalConfigResult>(`/telegram-portal/${token}/config`, input);
  return data;
}
