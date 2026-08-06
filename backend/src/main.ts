import 'reflect-metadata';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { isCorsOriginAllowed, setCorsAllowedDomain } from './common/cors-origin.state';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { SettingsService } from './system/settings.service';

const DEFAULT_LOG_LEVELS: LogLevel[] = ['error', 'warn', 'log'];

async function bootstrap() {
  // По умолчанию без debug/verbose — SshService и подобные логируют debug на КАЖДУЮ SSH-
  // команду (дашборд опрашивает серверы каждые несколько секунд), это заваливает лог шумом
  // и реально мешало искать настоящую ошибку при разборе инцидента 2026-08-03. Явно
  // включить обратно: LOG_LEVELS=error,warn,log,debug,verbose в окружении backend.
  const logger = (process.env.LOG_LEVELS?.split(',').map((level) => level.trim()) as LogLevel[] | undefined) ?? DEFAULT_LOG_LEVELS;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // nginx — единственный внешний вход (см. docker-compose.yml), поэтому trust proxy = 1
  // (доверяем ровно одному хопу) — иначе req.ip видел бы внутренний IP контейнера nginx
  // вместо реального клиента, и rate-limit (см. ThrottlerModule в app.module.ts) считал бы
  // всех пользователей одним IP.
  app.set('trust proxy', 1);

  // Домен панели может быть ещё не настроен (свежая установка) — тогда CORS остаётся
  // открытым, как и раньше; как только домен задан в "Настройки → Домен и HTTPS", сужаем
  // до него. setCorsAllowedDomain дальше вызывается и из SettingsService.update — доменом
  // можно управлять без рестарта backend.
  const settingsService = app.get(SettingsService);
  const settings = await settingsService.getOrCreate();
  setCorsAllowedDomain(settings.domain);
  app.enableCors({ origin: (origin, callback) => callback(null, isCorsOriginAllowed(origin)) });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap();
