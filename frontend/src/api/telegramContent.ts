import { apiClient } from './client';
import { TelegramContentPost } from './types';

export interface CreateTelegramContentInput {
  title?: string;
  body: string;
  images?: string[];
}

export async function fetchTelegramNews(): Promise<TelegramContentPost[]> {
  const { data } = await apiClient.get<TelegramContentPost[]>('/telegram-content/news');
  return data;
}

export async function createTelegramNews(input: CreateTelegramContentInput): Promise<TelegramContentPost> {
  const { data } = await apiClient.post<TelegramContentPost>('/telegram-content/news', input);
  return data;
}

export async function deleteTelegramNews(id: string): Promise<void> {
  await apiClient.delete(`/telegram-content/news/${id}`);
}

export async function fetchTelegramInstructions(): Promise<TelegramContentPost[]> {
  const { data } = await apiClient.get<TelegramContentPost[]>('/telegram-content/instructions');
  return data;
}

export async function createTelegramInstruction(input: CreateTelegramContentInput): Promise<TelegramContentPost> {
  const { data } = await apiClient.post<TelegramContentPost>('/telegram-content/instructions', input);
  return data;
}

export async function deleteTelegramInstruction(id: string): Promise<void> {
  await apiClient.delete(`/telegram-content/instructions/${id}`);
}
