import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { BridgesModule } from '../bridges/bridges.module';
import { Peer } from '../peers/peer.entity';
import { PeersModule } from '../peers/peers.module';
import { SshModule } from '../ssh/ssh.module';
import { SystemModule } from '../system/system.module';
import { VpnModule } from '../vpn/vpn.module';
import { MtProxyService } from './mtproxy.service';
import { ServerProtocol } from './server-protocol.entity';
import { Server } from './server.entity';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [
    // Bridge — здесь же (не только через BridgesModule, который его не реэкспортирует) для
    // MtProxyService.applyMtProxyRoutingBestEffort (см. VpnProvisioningService.setupMtProxyRouting).
    TypeOrmModule.forFeature([Server, ServerProtocol, Peer, Bridge]),
    SshModule,
    VpnModule,
    PeersModule,
    BridgesModule,
    SystemModule,
  ],
  controllers: [ServersController],
  providers: [ServersService, MtProxyService],
  // MtProxyService экспортирован — используется и из TelegramBotModule (портал показывает
  // постоянную ссылку на этом же self-сервере, см. TelegramPortalService).
  exports: [ServersService, MtProxyService],
})
export class ServersModule {}
