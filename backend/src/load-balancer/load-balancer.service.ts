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
    const bridges = await this.bridgesRepository.find({
      select: ['wireguardClientProtocolId', 'amneziawgClientProtocolId'],
    });
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

    // Один сгруппированный COUNT вместо отдельного запроса на каждого кандидата (было
    // N запросов на N серверов протокола при каждом создании peer'а без явного выбора
    // сервера).
    const counts = candidates.length
      ? await this.peersRepository
          .createQueryBuilder('peer')
          .select('peer.serverProtocolId', 'serverProtocolId')
          .addSelect('COUNT(*)', 'count')
          .where('peer.serverProtocolId IN (:...ids)', { ids: candidates.map((sp) => sp.id) })
          .andWhere('peer.status = :status', { status: PeerStatus.ACTIVE })
          .groupBy('peer.serverProtocolId')
          .getRawMany<{ serverProtocolId: string; count: string }>()
      : [];
    const countsByProtocolId = new Map(counts.map((c) => [c.serverProtocolId, Number(c.count)]));

    const withLoad = candidates.map((serverProtocol) => ({
      serverProtocol,
      activePeers: countsByProtocolId.get(serverProtocol.id) ?? 0,
    }));

    const withCapacity = withLoad.filter((item) => item.activePeers < item.serverProtocol.server.maxPeers);
    if (withCapacity.length === 0) {
      throw new BadRequestException('Все доступные серверы достигли лимита нагрузки');
    }

    withCapacity.sort((a, b) => a.activePeers - b.activePeers);
    return withCapacity[0].serverProtocol;
  }
}
