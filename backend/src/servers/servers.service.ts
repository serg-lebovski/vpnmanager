import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BridgesService } from '../bridges/bridges.service';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { ServerStatus, VpnProtocol } from '../common/enums';
import { PeersService } from '../peers/peers.service';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { CreateServerDto } from './dto/create-server.dto';
import { InstallProtocolDto } from './dto/install-protocol.dto';
import { ServerProtocol } from './server-protocol.entity';
import { Server } from './server.entity';

@Injectable()
export class ServersService {
  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    private readonly sshService: SshService,
    private readonly vpnProvisioningService: VpnProvisioningService,
    private readonly peersService: PeersService,
    private readonly bridgesService: BridgesService,
  ) {}

  findAll(): Promise<Server[]> {
    return this.serversRepository.find({ relations: ['protocols'], order: { createdAt: 'DESC' } });
  }

  async findOneOrFail(id: string): Promise<Server> {
    const server = await this.serversRepository.findOne({ where: { id }, relations: ['protocols'] });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }
    return server;
  }

  async create(dto: CreateServerDto): Promise<Server> {
    const server = this.serversRepository.create({
      name: dto.name,
      host: dto.host,
      sshPort: dto.sshPort ?? 22,
      sshUsername: dto.sshUsername,
      sshAuthType: dto.sshAuthType,
      sshSecretEnc: encryptSecret(dto.secret),
      maxPeers: dto.maxPeers ?? 100,
      status: ServerStatus.UNKNOWN,
    });
    return this.serversRepository.save(server);
  }

  async remove(id: string): Promise<void> {
    const server = await this.findOneOrFail(id);
    // Если сервер сейчас служит upstream для какого-то моста — переключаем мост на другой
    // доступный сервер того же протокола, прежде чем удалять (иначе мост остался бы без
    // upstream и без возможности исправить это иначе как вручную по SSH).
    const protocolIds = server.protocols.map((p) => p.id);
    await this.bridgesService.reassignUpstreamAwayFrom(protocolIds);
    await this.serversRepository.remove(server);
  }

  async testConnection(id: string): Promise<{ ok: boolean; info?: string; error?: string }> {
    const server = await this.findOneOrFail(id);
    const result = await this.sshService.testConnection({
      host: server.host,
      port: server.sshPort,
      username: server.sshUsername,
      authType: server.sshAuthType,
      secret: decryptSecret(server.sshSecretEnc),
    });
    server.status = result.ok ? ServerStatus.ONLINE : ServerStatus.OFFLINE;
    server.lastCheckedAt = new Date();
    server.lastError = result.ok ? null : result.error || null;
    await this.serversRepository.save(server);
    return result;
  }

  async installProtocol(serverId: string, dto: InstallProtocolDto): Promise<ServerProtocol> {
    return this.vpnProvisioningService.installProtocol(serverId, dto.protocol, dto.listenPort, dto.networkCidr);
  }

  async scanAndImport(serverProtocolId: string): Promise<{ importedCount: number }> {
    const importedCount = await this.peersService.importScannedPeers(serverProtocolId);
    return { importedCount };
  }

  // Проверяет сервер на уже существующую (не заведённую через сервис) установку
  // WireGuard и/или AmneziaWG по стандартным путям и, если находит, подключает её к
  // учёту (ServerProtocol) и сразу забирает её peers в базу. Ничего не устанавливает
  // и не перезапускает интерфейс — только читает и, при обнаружении, "усыновляет".
  async detectExistingInstallations(
    serverId: string,
  ): Promise<Array<{ protocol: VpnProtocol; found: boolean; importedCount?: number }>> {
    const results: Array<{ protocol: VpnProtocol; found: boolean; importedCount?: number }> = [];
    for (const protocol of [VpnProtocol.WIREGUARD, VpnProtocol.AMNEZIAWG]) {
      const serverProtocol = await this.vpnProvisioningService.detectExisting(serverId, protocol);
      if (!serverProtocol) {
        results.push({ protocol, found: false });
        continue;
      }
      const importedCount = await this.peersService.importScannedPeers(serverProtocol.id);
      results.push({ protocol, found: true, importedCount });
    }
    return results;
  }
}
