import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
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
})
export class AppModule {}
