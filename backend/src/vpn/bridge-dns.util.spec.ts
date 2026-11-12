import {
  bridgeDnsNames,
  bridgeShortId,
  DIRECT_DNS_RESOLVERS,
  renderBridgeDnsConfig,
  renderBridgeDnsUnit,
  renderIpsetRestoreScript,
  TUNNEL_DNS_RESOLVERS,
} from './bridge-dns.util';

describe('bridge-dns.util', () => {
  const bridgeId = '49717f0e-52e5-4868-8ca5-9e027109e37f';

  it('builds short names that fit ipset 31-char limit', () => {
    expect(bridgeShortId(bridgeId)).toBe('49717f0e52e54868');
    const names = bridgeDnsNames(bridgeId);
    expect(names.staticIpset).toBe('vpnmgr-byp-49717f0e52e54868');
    expect(names.dynamicIpset).toBe('vpnmgr-bypd-49717f0e52e54868');
    expect(names.dynamicIpset.length).toBeLessThanOrEqual(31);
    expect(`${names.staticIpset}-tmp`.length).toBeLessThanOrEqual(31);
  });

  it('renders dnsmasq config: direct resolvers + ipset for listed domains, tunnel for the rest', () => {
    const conf = renderBridgeDnsConfig({
      listenAddresses: ['10.9.0.1', '10.9.1.1'],
      domains: ['gosuslugi.ru', 'sber.ru'],
      dynamicIpset: 'vpnmgr-bypd-x',
      upstreamInterface: 'wg-up-3405ff15',
    });
    const lines = conf.trim().split('\n');
    expect(lines).toContain('listen-address=10.9.0.1');
    expect(lines).toContain('listen-address=10.9.1.1');
    expect(lines).toContain('no-resolv');
    for (const resolver of TUNNEL_DNS_RESOLVERS) {
      expect(lines).toContain(`server=${resolver}@wg-up-3405ff15`);
    }
    for (const domain of ['gosuslugi.ru', 'sber.ru']) {
      for (const resolver of DIRECT_DNS_RESOLVERS) {
        expect(lines).toContain(`server=/${domain}/${resolver}`);
      }
      expect(lines).toContain(`ipset=/${domain}/vpnmgr-bypd-x`);
    }
  });

  it('renders systemd unit pointing at the bridge config', () => {
    const names = bridgeDnsNames(bridgeId);
    const unit = renderBridgeDnsUnit(names);
    expect(unit).toContain(`--conf-file=${names.confPath}`);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('renders ipset restore script with atomic swap', () => {
    const script = renderIpsetRestoreScript('vpnmgr-byp-x', ['1.2.3.4/32', '5.6.0.0/16']);
    expect(script.trim().split('\n')).toEqual([
      'create vpnmgr-byp-x hash:net -exist',
      'create vpnmgr-byp-x-tmp hash:net -exist',
      'flush vpnmgr-byp-x-tmp',
      'add vpnmgr-byp-x-tmp 1.2.3.4/32 -exist',
      'add vpnmgr-byp-x-tmp 5.6.0.0/16 -exist',
      'swap vpnmgr-byp-x-tmp vpnmgr-byp-x',
      'destroy vpnmgr-byp-x-tmp',
    ]);
  });

  it('renders valid ipset restore script for an empty list (clears the set)', () => {
    const script = renderIpsetRestoreScript('vpnmgr-byp-x', []);
    expect(script).toContain('flush vpnmgr-byp-x-tmp');
    expect(script).toContain('swap vpnmgr-byp-x-tmp vpnmgr-byp-x');
  });
});
