import {
  buildVlessUri,
  extractXrayClients,
  parseX25519Output,
  parseXrayUserStats,
  PRIVATE_NETWORKS,
  renderTunConfig,
  renderXrayClientConfig,
  renderXrayServerConfig,
  xrayConfigWithoutClients,
} from './xray-config.util';

const params = { sni: 'www.microsoft.com', shortId: 'a1b2c3d4', flow: 'xtls-rprx-vision', fingerprint: 'chrome' };

describe('xray-config.util', () => {
  it('renders a plain VLESS server: direct egress, private networks blocked, no DNS override', () => {
    const config = renderXrayServerConfig({
      listenPort: 443,
      apiPort: 10085,
      privateKey: 'PRIV',
      params,
      clients: [{ uuid: 'u-1', email: 'p-1' }],
    }) as any;
    expect(config.inbounds[0].port).toBe(443);
    expect(config.inbounds[0].settings.clients).toEqual([{ id: 'u-1', email: 'p-1', flow: 'xtls-rprx-vision' }]);
    expect(config.inbounds[0].streamSettings.realitySettings).toMatchObject({
      target: 'www.microsoft.com:443',
      serverNames: ['www.microsoft.com'],
      privateKey: 'PRIV',
      shortIds: ['a1b2c3d4'],
    });
    expect(config.api.listen).toBe('127.0.0.1:10085');
    expect(config.outbounds[0].tag).toBe('direct');
    expect(config.routing.rules[0]).toEqual({ type: 'field', ip: PRIVATE_NETWORKS, outboundTag: 'block' });
    expect(config.dns).toBeUndefined();
  });

  it('renders a bridge VLESS server: default egress via fwmark, bypass list goes direct', () => {
    const config = renderXrayServerConfig({
      listenPort: 8443,
      apiPort: 10086,
      privateKey: 'PRIV',
      params,
      clients: [],
      routing: { mark: 52001, directDomains: ['gosuslugi.ru'], directIps: ['5.6.0.0/16'] },
    }) as any;
    expect(config.outbounds[0]).toMatchObject({ tag: 'via-bridge', streamSettings: { sockopt: { mark: 52001 } } });
    expect(config.outbounds.map((o: any) => o.tag)).toEqual(['via-bridge', 'direct', 'block']);
    const rules = config.routing.rules;
    expect(rules).toContainEqual({ type: 'field', domain: ['domain:gosuslugi.ru'], outboundTag: 'direct' });
    expect(rules).toContainEqual({ type: 'field', ip: ['5.6.0.0/16'], outboundTag: 'direct' });
    expect(config.dns.servers[0]).toMatchObject({ address: '77.88.8.8', domains: ['domain:gosuslugi.ru'] });
    expect(config.dns.servers).toContain('1.1.1.1');
  });

  it('extracts clients and compares configs ignoring the client list', () => {
    const base = { listenPort: 443, apiPort: 10085, privateKey: 'PRIV', params };
    const a = renderXrayServerConfig({ ...base, clients: [{ uuid: 'u-1', email: 'p-1' }] });
    const b = renderXrayServerConfig({ ...base, clients: [{ uuid: 'u-2', email: 'p-2' }] });
    const c = renderXrayServerConfig({ ...base, clients: [], routing: { mark: 7 } });
    expect(extractXrayClients(a)).toEqual([{ uuid: 'u-1', email: 'p-1' }]);
    expect(xrayConfigWithoutClients(a)).toBe(xrayConfigWithoutClients(b));
    expect(xrayConfigWithoutClients(a)).not.toBe(xrayConfigWithoutClients(c));
    expect(extractXrayClients(null)).toEqual([]);
  });

  it('renders the bridge client config and the tun config', () => {
    const client = renderXrayClientConfig({ socksPort: 42001, host: '1.2.3.4', port: 443, uuid: 'u-1', publicKey: 'PUB', params }) as any;
    expect(client.inbounds[0]).toMatchObject({ listen: '127.0.0.1', port: 42001, protocol: 'socks' });
    expect(client.outbounds[0].settings.vnext[0]).toMatchObject({ address: '1.2.3.4', port: 443 });
    expect(client.outbounds[0].streamSettings.realitySettings).toMatchObject({ publicKey: 'PUB', serverName: 'www.microsoft.com' });
    const tun = renderTunConfig({ interfaceName: 'wg-up-1234', socksPort: 42001, tunAddress: '198.18.1.1' });
    expect(tun).toContain('name: wg-up-1234');
    expect(tun).toContain('port: 42001');
  });

  it('builds a vless:// link Happ can import', () => {
    const uri = buildVlessUri({ uuid: 'u-1', host: 'bridge.example.com', port: 8443, publicKey: 'PUB', params, name: 'Телефон' });
    expect(uri.startsWith('vless://u-1@bridge.example.com:8443?')).toBe(true);
    const url = new URL(uri.replace('vless://', 'http://'));
    expect(url.searchParams.get('security')).toBe('reality');
    expect(url.searchParams.get('pbk')).toBe('PUB');
    expect(url.searchParams.get('sid')).toBe('a1b2c3d4');
    expect(url.searchParams.get('flow')).toBe('xtls-rprx-vision');
    expect(decodeURIComponent(url.hash.slice(1))).toBe('Телефон');
  });

  it('parses user traffic stats and x25519 output', () => {
    const stats = parseXrayUserStats(
      JSON.stringify({
        stat: [
          { name: 'user>>>p-1>>>traffic>>>uplink', value: '100' },
          { name: 'user>>>p-1>>>traffic>>>downlink', value: 2000 },
          { name: 'inbound>>>vless-in>>>traffic>>>uplink', value: 5 },
        ],
      }),
    );
    expect(stats.get('p-1')).toEqual({ uplink: 100, downlink: 2000 });
    expect(parseXrayUserStats('garbage').size).toBe(0);

    const keys = parseX25519Output(
      'PrivateKey: aB3_-cdefghijklmnopqrstuvwxyz0123456789ABCDE\nPassword: zZ3_-cdefghijklmnopqrstuvwxyz0123456789ABCDE\nHash32: xx\n',
    );
    expect(keys.privateKey.startsWith('aB3')).toBe(true);
    expect(keys.publicKey.startsWith('zZ3')).toBe(true);
  });
});
