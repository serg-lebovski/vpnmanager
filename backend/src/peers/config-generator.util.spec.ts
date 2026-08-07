import { Peer } from './peer.entity';
import { Server } from '../servers/server.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { buildClientConfig } from './config-generator.util';

function makePeer(overrides: Partial<Peer> = {}): Peer {
  return { allowedIp: '10.8.0.5', dns: '1.1.1.1', ...overrides } as Peer;
}

function makeServer(overrides: Partial<Server> = {}): Server {
  return { host: '203.0.113.10', ...overrides } as Server;
}

function makeServerProtocol(overrides: Partial<ServerProtocol> = {}): ServerProtocol {
  return { serverPublicKey: 'server-pub-key', listenPort: 51820, ...overrides } as ServerProtocol;
}

describe('buildClientConfig', () => {
  it('renders the base [Interface]/[Peer] sections', () => {
    const config = buildClientConfig(makePeer(), 'client-priv-key', makeServer(), makeServerProtocol());
    expect(config).toContain('[Interface]');
    expect(config).toContain('PrivateKey = client-priv-key');
    expect(config).toContain('Address = 10.8.0.5/32');
    expect(config).toContain('DNS = 1.1.1.1');
    expect(config).toContain('[Peer]');
    expect(config).toContain('PublicKey = server-pub-key');
    expect(config).toContain('Endpoint = 203.0.113.10:51820');
    expect(config).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(config).toContain('PersistentKeepalive = 25');
  });

  it('omits MTU when not set on the server protocol', () => {
    const config = buildClientConfig(makePeer(), 'k', makeServer(), makeServerProtocol());
    expect(config).not.toContain('MTU');
  });

  it('includes MTU when set on the server protocol', () => {
    const config = buildClientConfig(makePeer(), 'k', makeServer(), makeServerProtocol({ mtu: 1280 }));
    expect(config).toContain('MTU = 1280');
  });

  it('omits PresharedKey when not provided', () => {
    const config = buildClientConfig(makePeer(), 'k', makeServer(), makeServerProtocol());
    expect(config).not.toContain('PresharedKey');
  });

  it('includes PresharedKey when provided', () => {
    const config = buildClientConfig(makePeer(), 'k', makeServer(), makeServerProtocol(), 'psk-value');
    expect(config).toContain('PresharedKey = psk-value');
  });

  it('appends obfuscation params as raw key = value lines (AmneziaWG)', () => {
    const config = buildClientConfig(
      makePeer(),
      'k',
      makeServer(),
      makeServerProtocol({ obfuscationParams: { Jc: '4', Jmin: '40', Jmax: '70' } }),
    );
    expect(config).toContain('Jc = 4');
    expect(config).toContain('Jmin = 40');
    expect(config).toContain('Jmax = 70');
  });

  it('uses the bridge domain name in place of the server host when passed in', () => {
    const config = buildClientConfig(makePeer(), 'k', makeServer({ host: 'vpn.example.com' }), makeServerProtocol());
    expect(config).toContain('Endpoint = vpn.example.com:51820');
  });
});
