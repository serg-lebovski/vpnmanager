import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { PeerStatus, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';

@Injectable()
export class LoadBalancerService {
  constructor(
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
  ) {}

  // allowedServerIds — если передан (не undefined), ограничивает выбор ТОЛЬКО этими
  // серверами (см. Organization.allowedServerIds/PeersService) — используется для
  // org_admin/org_user с ограниченным доступом; undefined — без ограничения (суперадмин,
  // либо системные вызовы вроде createSystemPeer моста).
  async pickServerProtocol(protocol: VpnProtocol, allowedServerIds?: string[]): Promise<ServerProtocol> {
    const allCandidates = await this.serverProtocolsRepository.find({
      where: { protocol, status: ServerProtocolStatus.ACTIVE },
      relations: ['server'],
    });

    // Клиентские интерфейсы мостов (на self-сервере, к которым подключаются клиенты
    // конкретного моста) не должны попадать в общий пул автобалансировки — иначе peer,
    // созданный без явного выбора сервера/моста, мог бы случайно оказаться клиентом
    // чужого моста. Бридж-peers назначаются только явно (см. bridgeId в CreatePeerDto).
    const bridges = await this.bridgesRepository.find();
    const bridgeClientProtocolIds = new Set(
      bridges.flatMap((bridge) => [bridge.wireguardClientProtocolId, bridge.amneziawgClientProtocolId]).filter(Boolean),
    );
    let candidates = allCandidates.filter((sp) => !bridgeClientProtocolIds.has(sp.id));
    if (allowedServerIds) {
      const allowedSet = new Set(allowedServerIds);
      candidates = candidates.filter((sp) => allowedSet.has(sp.serverId));
    }
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
