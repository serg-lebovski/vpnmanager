// Простой module-level singleton (тот же паттерн, что cachedKey в encryption.util.ts) —
// main.ts подключает CORS-делегат ДО того, как DI-контейнер готов раздавать сервисы по
// HTTP-запросам, а домен панели (SystemSettings.domain) может поменяться в рантайме без
// рестарта (см. SettingsService.update) — держать значение в закрытой переменной проще,
// чем городить отдельный сервис ради одного примитива состояния.
let allowedDomain: string | null = null;

export function setCorsAllowedDomain(domain: string | null): void {
  allowedDomain = domain;
}

// null/undefined domain (панель ещё не настроена) — не ломаем первоначальную настройку,
// пропускаем любой Origin, как и раньше (app.enableCors() без опций). Как только домен
// задан — CORS сужается строго до него (http и https — на случай временного HTTP-only).
// Запросы без Origin (curl, серверные вызовы, самбл-origin в некоторых браузерах) —
// пропускаем всегда, для них Origin-проверка браузера всё равно не применяется.
export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!allowedDomain || !origin) {
    return true;
  }
  return origin === `https://${allowedDomain}` || origin === `http://${allowedDomain}`;
}
