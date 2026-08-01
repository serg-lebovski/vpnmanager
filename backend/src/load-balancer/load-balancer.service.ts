import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PeerStatus, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';

@Injectable()
export class LoadBalancerService {
  constructor(
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
  ) {}

  async pickServerProtocol(protocol: VpnProtocol): Promise<ServerProtocol> {
    const candidates = await this.serverProtocolsRepository.find({
      where: { protocol, status: ServerProtocolStatus.ACTIVE },
      relations: ['server'],
    });
    if (candidates.length === 0) {
      throw new BadRequestException(`Нет активных серверов с установленным протоколом ${protocol}`);
    }

    const withLoad = await Promise.all(
      candidates.map(async (serverProtocol) => ({
        serverProtocol,
        activePeers: await this.peersRepository.count({
          where: { serverProtocolId: serverProtocol.id, status: PeerStatus.ACTIVE },
        }),
      })),
    );

    const withCapacity = withLoad.filter((item) => item.activePeers < item.serverProtocol.server.maxPeers);
    if (withCapacity.length === 0) {
      throw new BadRequestException('Все доступные серверы достигли лимита нагрузки');
    }

    withCapacity.sort((a, b) => a.activePeers - b.activePeers);
    return withCapacity[0].serverProtocol;
  }
}
