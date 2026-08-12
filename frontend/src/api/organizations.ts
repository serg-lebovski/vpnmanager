import { apiClient } from './client';
import { Organization } from './types';

export async function fetchOrganizations(): Promise<Organization[]> {
  const { data } = await apiClient.get<Organization[]>('/organizations');
  return data;
}

export interface CreateOrganizationInput {
  name: string;
  inn?: string;
}

export async function createOrganization(input: CreateOrganizationInput): Promise<Organization> {
  const { data } = await apiClient.post<Organization>('/organizations', input);
  return data;
}

export async function fetchOrganization(id: string): Promise<Organization> {
  const { data } = await apiClient.get<Organization>(`/organizations/${id}`);
  return data;
}

export interface UpdateOrganizationInput {
  name?: string;
  inn?: string;
  allowedServerIds?: string[];
  blockedBridgeIds?: string[];
}

export async function updateOrganization(id: string, input: UpdateOrganizationInput): Promise<Organization> {
  const { data } = await apiClient.patch<Organization>(`/organizations/${id}`, input);
  return data;
}

export async function deleteOrganization(id: string): Promise<void> {
  await apiClient.delete(`/organizations/${id}`);
}
