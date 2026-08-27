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

export async function updateServer(
  id: string,
  input: { name?: string; maxPeers?: number; amneziaAppName?: string | null },
): Promise<ServerEntity> {
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

// Подтверждённая администратором перезагрузка сервера, когда установка/подключение
// upstream упёрлись в KERNEL_REBOOT_REQUIRED (см. KernelRebootConfirmDialog) — модуль
// протокола собран не под текущее ядро, только перезагрузка сервера применит нужный.
export async function rebootForKernelModule(serverId: string, protocol: VpnProtocol): Promise<{ message: string }> {
  const { data } = await apiClient.post(`/servers/${serverId}/reboot-for-kernel-module`, { protocol });
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

export interface Fail2banStatus {
  installed: boolean;
  bannedCount: number;
}

// Проверяет/устанавливает fail2ban на сервере и заносит IP self-сервера панели в
// whitelist — тот же вызов, что автоматически (best-effort) срабатывает при добавлении
// сервера; кнопка нужна, чтобы повторить, если тогда не получилось, или просто
// освежить счётчик забаненных IP.
export async function ensureFail2ban(serverId: string): Promise<Fail2banStatus> {
  const { data } = await apiClient.post<Fail2banStatus>(`/servers/${serverId}/fail2ban`);
  return data;
}

// Сброс TOFU-отпечатка SSH host key — после легитимной переустановки/смены сервера,
// иначе панель отклоняла бы подключение как возможную подмену навсегда.
export async function resetHostKeyFingerprint(serverId: string): Promise<ServerEntity> {
  const { data } = await apiClient.post<ServerEntity>(`/servers/${serverId}/reset-host-key`);
  return data;
}

export interface MtProxyStatus {
  installed: boolean;
  server: string | null;
  port: number | null;
  secret: string | null;
  deepLink: string | null;
  updatedAt: string | null;
}

// Текущее состояние постоянного MTProto-proxy self-сервера, без переустановки — доступно
// только для сервера с isSelf: true (см. MtProxyService на бэкенде).
export async function fetchMtProxyStatus(serverId: string): Promise<MtProxyStatus> {
  const { data } = await apiClient.get<MtProxyStatus>(`/servers/${serverId}/mtproxy`);
  return data;
}

// Создать (если ещё не установлен) или полностью переустановить — новые порт+ключ,
// systemd-юнит разворачивается заново. Ссылка, уже разосланная клиентам до этого, перестаёт
// работать (в отличие от автоматической ежесуточной ротации ключа, которая порт не трогает).
export async function installMtProxy(serverId: string): Promise<MtProxyStatus> {
  const { data } = await apiClient.post<MtProxyStatus>(`/servers/${serverId}/mtproxy`);
  return data;
}
