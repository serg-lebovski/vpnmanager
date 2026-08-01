import { apiClient } from './client';
import { AppUser, Role } from './types';

export async function fetchUsers(): Promise<AppUser[]> {
  const { data } = await apiClient.get<AppUser[]>('/users');
  return data;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: Role;
  organizationId?: string;
}

export async function createUser(input: CreateUserInput): Promise<AppUser> {
  const { data } = await apiClient.post<AppUser>('/users', input);
  return data;
}

export async function deleteUser(id: string): Promise<void> {
  await apiClient.delete(`/users/${id}`);
}
