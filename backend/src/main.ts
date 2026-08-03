import 'reflect-metadata';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

const DEFAULT_LOG_LEVELS: LogLevel[] = ['error', 'warn', 'log'];

async function bootstrap() {
  // По умолчанию без debug/verbose — SshService и подобные логируют debug на КАЖДУЮ SSH-
  // команду (дашборд опрашивает серверы каждые несколько секунд), это заваливает лог шумом
  // и реально мешало искать настоящую ошибку при разборе инцидента 2026-08-03. Явно
  // включить обратно: LOG_LEVELS=error,warn,log,debug,verbose в окружении backend.
  const logger = (process.env.LOG_LEVELS?.split(',').map((level) => level.trim()) as LogLevel[] | undefined) ?? DEFAULT_LOG_LEVELS;
  const app = await NestFactory.create(AppModule, { logger });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap();
