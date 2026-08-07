import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { LoadBalancerService } from './load-balancer.service';

function makeServerProtocol(id: string, maxPeers: number): ServerProtocol {
  return {
    id,
    serverId: `server-${id}`,
    protocol: VpnProtocol.WIREGUARD,
    status: ServerProtocolStatus.ACTIVE,
    server: { id: `server-${id}`, maxPeers },
  } as unknown as ServerProtocol;
}

// pickServerProtocol считает нагрузку одним сгруппированным COUNT-запросом (createQueryBuilder),
// а не отдельным count() на каждого кандидата — мок воспроизводит ту же цепочку вызовов,
// отдавая заранее заданные пары (serverProtocolId, count) через getRawMany.
function makeQueryBuilderMock(counts: Record<string, number>) {
  const rows = Object.entries(counts).map(([serverProtocolId, count]) => ({ serverProtocolId, count: String(count) }));
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  return builder;
}

describe('LoadBalancerService.pickServerProtocol', () => {
  let serverProtocolsRepository: jest.Mocked<Pick<Repository<ServerProtocol>, 'find'>>;
  let peersRepository: jest.Mocked<Pick<Repository<Peer>, 'createQueryBuilder'>>;
  let bridgesRepository: jest.Mocked<Pick<Repository<Bridge>, 'find'>>;
  let service: LoadBalancerService;
  let peerCounts: Record<string, number>;

  beforeEach(() => {
    peerCounts = {};
    serverProtocolsRepository = { find: jest.fn() };
    peersRepository = { createQueryBuilder: jest.fn(() => makeQueryBuilderMock(peerCounts)) };
    bridgesRepository = { find: jest.fn().mockResolvedValue([]) };
    service = new LoadBalancerService(
      serverProtocolsRepository as unknown as Repository<ServerProtocol>,
      peersRepository as unknown as Repository<Peer>,
      bridgesRepository as unknown as Repository<Bridge>,
    );
  });

  it('picks the candidate with the fewest active peers', async () => {
    const busy = makeServerProtocol('busy', 100);
    const idle = makeServerProtocol('idle', 100);
    serverProtocolsRepository.find.mockResolvedValue([busy, idle]);
    peerCounts = { busy: 10, idle: 2 };

    const picked = await service.pickServerProtocol(VpnProtocol.WIREGUARD);
    expect(picked.id).toBe('idle');
  });

  it('excludes server protocols that are used as a bridge client interface', async () => {
    const bridgeClient = makeServerProtocol('bridge-client', 100);
    const regular = makeServerProtocol('regular', 100);
    serverProtocolsRepository.find.mockResolvedValue([bridgeClient, regular]);
    bridgesRepository.find.mockResolvedValue([
      { wireguardClientProtocolId: 'bridge-client', amneziawgClientProtocolId: null },
    ] as Bridge[]);

    const picked = await service.pickServerProtocol(VpnProtocol.WIREGUARD);
    expect(picked.id).toBe('regular');
  });

  it('restricts candidates to allowedServerIds when provided', async () => {
    const allowed = makeServerProtocol('allowed', 100);
    const blocked = makeServerProtocol('blocked', 100);
    serverProtocolsRepository.find.mockResolvedValue([allowed, blocked]);

    const picked = await service.pickServerProtocol(VpnProtocol.WIREGUARD, ['server-allowed']);
    expect(picked.id).toBe('allowed');
  });

  it('throws when no active candidates exist for the protocol', async () => {
    serverProtocolsRepository.find.mockResolvedValue([]);
    await expect(service.pickServerProtocol(VpnProtocol.WIREGUARD)).rejects.toThrow(BadRequestException);
  });

  it('throws when every candidate is at its maxPeers capacity', async () => {
    const full = makeServerProtocol('full', 5);
    serverProtocolsRepository.find.mockResolvedValue([full]);
    peerCounts = { full: 5 };

    await expect(service.pickServerProtocol(VpnProtocol.WIREGUARD)).rejects.toThrow('Все доступные серверы достигли лимита нагрузки');
  });

  it('skips full candidates in favor of one with remaining capacity', async () => {
    const full = makeServerProtocol('full', 5);
    const hasRoom = makeServerProtocol('has-room', 5);
    serverProtocolsRepository.find.mockResolvedValue([full, hasRoom]);
    peerCounts = { full: 5, 'has-room': 4 };

    const picked = await service.pickServerProtocol(VpnProtocol.WIREGUARD);
    expect(picked.id).toBe('has-room');
  });
});
