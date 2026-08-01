import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { SshModule } from '../ssh/ssh.module';
import { AmneziaWgDriver } from './amnezia-wg.driver';
import { VpnProvisioningService } from './vpn-provisioning.service';
import { WireGuardDriver } from './wireguard.driver';

@Module({
  imports: [SshModule, TypeOrmModule.forFeature([Server, ServerProtocol])],
  providers: [WireGuardDriver, AmneziaWgDriver, VpnProvisioningService],
  exports: [VpnProvisioningService],
})
export class VpnModule {}
