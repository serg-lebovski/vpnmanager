import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AuditLogInterceptor } from './audit-log/audit-log.interceptor';
import { AuditLogModule } from './audit-log/audit-log.module';
import { AuthModule } from './auth/auth.module';
import { BridgesModule } from './bridges/bridges.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { LoadBalancerModule } from './load-balancer/load-balancer.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PeersModule } from './peers/peers.module';
import { ServersModule } from './servers/servers.module';
import { SshModule } from './ssh/ssh.module';
import { SystemModule } from './system/system.module';
import { UsersModule } from './users/users.module';
import { VpnModule } from './vpn/vpn.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Глобальный лимит на IP — базовая защита от перебора/скрейпинга API в целом; логин
    // отдельно ограничен строже (см. AuthController.login), т.к. это основная цель
    // перебора. req.ip корректно видит реальный IP клиента, а не адрес nginx, только если
    // включён 'trust proxy' (см. main.ts) — nginx уже прокидывает X-Forwarded-For/X-Real-IP.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.getOrThrow<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.getOrThrow<string>('DB_USER'),
        password: configService.getOrThrow<string>('DB_PASSWORD'),
        database: configService.getOrThrow<string>('DB_NAME'),
        autoLoadEntities: true,
        // MVP: автосинхронизация схемы вместо ручных миграций для быстрого первого разворачивания.
        // Для продакшен-эксплуатации в дальнейшем стоит перейти на TypeORM-миграции.
        synchronize: true,
      }),
    }),
    AuditLogModule,
    AuthModule,
    DatabaseModule,
    OrganizationsModule,
    UsersModule,
    SshModule,
    VpnModule,
    ServersModule,
    LoadBalancerModule,
    PeersModule,
    BridgesModule,
    SystemModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
