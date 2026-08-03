import axios from 'axios';

// Отдельный от apiClient запрос: без токена авторизации и без interceptor'а
// авто-рефреша (см. client.ts) — этому пингу не нужна ни авторизация, ни ретраи, только
// сам факт "backend ответил".
export async function checkBackendHealth(): Promise<boolean> {
  try {
    await axios.get('/api/health', { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}
