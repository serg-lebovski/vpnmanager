import { apiClient } from './client';
import { Organization } from './types';

export async function fetchOrganizations(): Promise<Organization[]> {
  const { data } = await apiClient.get<Organization[]>('/organizations');
  return data;
}

export interface CreateOrganizationInput {
  name: string;
  adminEmail: string;
  adminPassword: string;
}

export async function createOrganization(input: CreateOrganizationInput): Promise<Organization> {
  const { data } = await apiClient.post<Organization>('/organizations', input);
  return data;
}

export async function deleteOrganization(id: string): Promise<void> {
  await apiClient.delete(`/organizations/${id}`);
}
