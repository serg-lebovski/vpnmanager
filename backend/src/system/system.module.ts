import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BackupService } from './backup.service';
import { SystemController } from './system.controller';
import { SystemGateway } from './system.gateway';
import { UpdateService } from './update.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [SystemController],
  providers: [BackupService, UpdateService, SystemGateway],
})
export class SystemModule {}
