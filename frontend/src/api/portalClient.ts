import axios from 'axios';

// Отдельный от apiClient (client.ts) инстанс — публичные /telegram-portal/*-эндпоинты не
// требуют и не должны получать Authorization-заголовок панели, а 401 (которого тут в норме
// не бывает) не должен запускать refresh-flow/редирект на /login, рассчитанный на
// авторизованных пользователей панели.
export const portalClient = axios.create({
  baseURL: '/api',
});
