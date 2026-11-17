import { Repository } from 'typeorm';
import { encryptSecret } from '../common/encryption.util';
import { BridgeStatus, PeerStatus, VpnProtocol } from '../common/enums';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { BridgesService } from './bridges.service';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'a-valid-test-key-1234567890';
});

const selfServer = { id: 'self', name: 'Этот сервер', host: '1.2.3.4', mtProxyPort: null };
const upstreamServer = { id: 'up', name: 'DE', host: '5.6.7.8' };

function makeBridge() {
  return {
    id: '49717f0e-52e5-4868-0000-000000000000',
    name: 'Main',
    status: BridgeStatus.ACTIVE,
    routeTable: 52000,
    upstreamInterfaceName: 'wg-up-1',
    upstreamPeerId: 'upstream-peer',
    upstreamServerProtocolId: 'up-sp',
    upstreamServerProtocol: {
      id: 'up-sp',
      protocol: VpnProtocol.AMNEZIAWG,
      listenPort: 443,
      serverPublicKey: 'UPSTREAM_PUB',
      obfuscationParams: { Jc: 4 },
      server: upstreamServer,
    },
    wireguardClientProtocol: { id: 'wg-sp', interfaceName: 'wg-br-1', networkCidr: '10.9.0.0/24', server: selfServer },
    amneziawgClientProtocol: { id: 'awg-sp', interfaceName: 'awg-br-1', networkCidr: '10.9.1.0/24', server: selfServer },
    wireguardClientProtocolId: 'wg-sp',
    amneziawgClientProtocolId: 'awg-sp',
    bypassDestinations: ['gosuslugi.ru'],
  };
}

function makeService(state: { missingClientInterfaces: string[]; upstreamOk: boolean; natOk: boolean; bypassOk: boolean }) {
  const bridge = makeBridge();
  const bridgesRepository = { findOne: jest.fn().mockResolvedValue(bridge), update: jest.fn() };
  const peersRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'upstream-peer',
      status: PeerStatus.ACTIVE,
      allowedIp: '10.8.1.5',
      privateKeyEnc: encryptSecret('UPSTREAM_PEER_PRIV'),
      presharedKeyEnc: null,
    }),
  };
  const settingsRepository = { findOne: jest.fn().mockResolvedValue({ telegramBridgeId: null }) };
  const vpn = {
    inspectBridgeState: jest.fn().mockResolvedValue(state),
    loadServerPrivateKey: jest.fn().mockResolvedValue('WG_SERVER_PRIV'),
    restoreInterface: jest.fn().mockResolvedValue(undefined),
    ensureClientToolsInstalled: jest.fn().mockResolvedValue(undefined),
    connectBridgeUpstream: jest.fn().mockResolvedValue(undefined),
    setupBridgeNat: jest.fn().mockResolvedValue(undefined),
    setupBridgeBypass: jest.fn().mockResolvedValue(undefined),
  };
  const peersService = { getActivePeerSpecs: jest.fn().mockResolvedValue([{ publicKey: 'P1', allowedIp: '10.9.0.2' }]) };
  const bridgeLogService = { log: jest.fn() };
  const service = new BridgesService(
    bridgesRepository as unknown as Repository<any>,
    {} as Repository<any>,
    {} as Repository<any>,
    {} as Repository<any>,
    peersRepository as unknown as Repository<any>,
    {} as Repository<any>,
    settingsRepository as unknown as Repository<any>,
    {} as any,
    peersService as any,
    vpn as any,
    { broadcastProgress: jest.fn() } as any,
    bridgeLogService as any,
  );
  return { service, vpn, bridgesRepository, peersService };
}

describe('BridgesService.restoreBridge', () => {
  it('ничего не трогает, если обвязка моста на месте', async () => {
    const { service, vpn } = makeService({ missingClientInterfaces: [], upstreamOk: true, natOk: true, bypassOk: true });
    await expect(service.restoreBridge('b')).resolves.toEqual({ restored: [] });
    expect(vpn.restoreInterface).not.toHaveBeenCalled();
    expect(vpn.connectBridgeUpstream).not.toHaveBeenCalled();
    expect(vpn.setupBridgeNat).not.toHaveBeenCalled();
    expect(vpn.setupBridgeBypass).not.toHaveBeenCalled();
  });

  it('после перезагрузки/переезда поднимает интерфейс с ключом из БД и upstream тем же peer', async () => {
    const { service, vpn, peersService } = makeService({
      missingClientInterfaces: ['wg-br-1'],
      upstreamOk: false,
      natOk: false,
      bypassOk: false,
    });
    const result = await service.restoreBridge('b');

    expect(vpn.loadServerPrivateKey).toHaveBeenCalledWith('wg-sp');
    expect(peersService.getActivePeerSpecs).toHaveBeenCalledWith('wg-sp');
    expect(vpn.restoreInterface).toHaveBeenCalledTimes(1);
    expect(vpn.restoreInterface.mock.calls[0][0]).toMatchObject({ id: 'wg-sp' });
    expect(vpn.restoreInterface.mock.calls[0][2]).toBe('WG_SERVER_PRIV');

    expect(vpn.connectBridgeUpstream).toHaveBeenCalledWith(
      selfServer,
      VpnProtocol.AMNEZIAWG,
      'wg-up-1',
      expect.objectContaining({
        privateKey: 'UPSTREAM_PEER_PRIV',
        address: '10.8.1.5/32',
        serverPublicKey: 'UPSTREAM_PUB',
        endpointHost: '5.6.7.8',
        endpointPort: 443,
      }),
      52000,
    );
    expect(vpn.setupBridgeNat).toHaveBeenCalledTimes(1);
    expect(vpn.setupBridgeBypass).toHaveBeenCalledTimes(1);
    expect(result.restored).toHaveLength(4);
  });

  it('не запускает два восстановления одного моста параллельно', async () => {
    const { service } = makeService({ missingClientInterfaces: [], upstreamOk: false, natOk: true, bypassOk: true });
    const first = service.restoreBridge('b');
    await expect(service.restoreBridge('b')).rejects.toThrow('уже выполняется');
    await first;
  });
});

describe('VpnProvisioningService.inspectBridgeState', () => {
  function makeProvisioning(stdout: string) {
    const exec = jest.fn().mockResolvedValue({ code: 0, stdout, stderr: '' });
    const sshService = {
      exec,
      withConnection: jest.fn((_params: unknown, fn: (ssh: unknown) => unknown) => fn({})),
    } as unknown as SshService;
    const service = new VpnProvisioningService(
      sshService,
      {} as any,
      {} as any,
      { update: jest.fn() } as any,
      {} as any,
      { log: jest.fn() } as any,
    );
    return { service, exec };
  }
  const input = {
    id: '49717f0e-52e5-4868-0000-000000000000',
    clientInterfaces: [{ networkCidr: '10.9.0.0/24', interfaceName: 'wg-br-1' }],
    upstreamInterfaceName: 'wg-up-1',
    routeTable: 52000,
    checkBypass: true,
  };
  const server = { id: 's', name: 's', host: 'h', sshPort: 22, sshUsername: 'root', sshAuthType: 'password', sshSecretEnc: '' } as any;

  it('разбирает вывод проверки', async () => {
    const { service, exec } = makeProvisioning('missing wg-br-1\nnat-ok\n');
    jest.spyOn(service, 'connectionParams').mockReturnValue({} as any);
    await expect(service.inspectBridgeState(server, input)).resolves.toEqual({
      missingClientInterfaces: ['wg-br-1'],
      upstreamOk: false,
      natOk: true,
      bypassOk: false,
    });
    const script: string = exec.mock.calls[0][1];
    expect(script).toContain('ip route show table 52000 | grep -q "^default dev wg-up-1 "');
    expect(script).toContain('from 10.9.0.0/24 lookup 52000');
    expect(script).toContain('grep -qx "vpnmgr-byp-49717f0e52e54868"');
  });

  it('всё на месте', async () => {
    const { service } = makeProvisioning('upstream-ok\nnat-ok\nbypass-ok\n');
    jest.spyOn(service, 'connectionParams').mockReturnValue({} as any);
    await expect(service.inspectBridgeState(server, input)).resolves.toEqual({
      missingClientInterfaces: [],
      upstreamOk: true,
      natOk: true,
      bypassOk: true,
    });
  });
});
