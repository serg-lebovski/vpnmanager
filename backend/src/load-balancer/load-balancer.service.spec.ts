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

describe('LoadBalancerService.pickServerProtocol', () => {
  let serverProtocolsRepository: jest.Mocked<Pick<Repository<ServerProtocol>, 'find'>>;
  let peersRepository: jest.Mocked<Pick<Repository<Peer>, 'count'>>;
  let bridgesRepository: jest.Mocked<Pick<Repository<Bridge>, 'find'>>;
  let service: LoadBalancerService;

  beforeEach(() => {
    serverProtocolsRepository = { find: jest.fn() };
    peersRepository = { count: jest.fn() };
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
    peersRepository.count.mockImplementation(({ where }: any) => Promise.resolve(where.serverProtocolId === 'busy' ? 10 : 2));

    const picked = await service.pickServerProtocol(VpnProtocol.WIREGUARD);
    expect(picked.id).toBe('idle');
  });

  it('excludes server protocols that are used as a bridge client interface', async () => {
    const bridgeClient = makeServerProtocol('bridge-client', 100);
    const regular = makeServerProtocol('regular', 100);
    serverProtocolsRepository.find.mockResolvedValue([bridgeClient, regular]);
    peersRepository.count.mockResolvedValue(0);
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
    peersRepository.count.mockResolvedValue(0);

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
    peersRepository.count.mockResolvedValue(5);

    await expect(service.pickServerProtocol(VpnProtocol.WIREGUARD)).rejects.toThrow('Все доступные серверы достигли лимита нагрузки');
  });

  it('skips full candidates in favor of one with remaining capacity', async () => {
    const full = makeServerProtocol('full', 5);
    const hasRoom = makeServerProtocol('has-room', 5);
    serverProtocolsRepository.find.mockResolvedValue([full, hasRoom]);
    peersRepository.count.mockImplementation(({ where }: any) => Promise.resolve(where.serverProtocolId === 'full' ? 5 : 4));

    const picked = await service.pickServerProtocol(VpnProtocol.WIREGUARD);
    expect(picked.id).toBe('has-room');
  });
});
