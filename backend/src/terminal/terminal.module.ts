import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Server } from '../servers/server.entity';
import { SshModule } from '../ssh/ssh.module';
import { VpnModule } from '../vpn/vpn.module';
import { TerminalGateway } from './terminal.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([Server]),
    SshModule,
    VpnModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [TerminalGateway],
})
export class TerminalModule {}
