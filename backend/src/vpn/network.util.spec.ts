import { BadRequestException } from '@nestjs/common';
import { assertSupportedCidr, classifyBypassEntry, gatewayAddress, hostAddress, networkPrefix, nextCidr } from './network.util';

describe('assertSupportedCidr', () => {
  it('accepts a /24 network', () => {
    expect(() => assertSupportedCidr('10.8.0.0/24')).not.toThrow();
  });

  it.each(['10.8.0.0/16', '10.8.0.5/24', 'not-a-cidr', '10.8.0.0/23'])('rejects %s', (cidr) => {
    expect(() => assertSupportedCidr(cidr)).toThrow(BadRequestException);
  });
});

describe('networkPrefix', () => {
  it('extracts the /24 prefix', () => {
    expect(networkPrefix('10.8.0.0/24')).toBe('10.8.0');
  });

  it('throws on an invalid CIDR', () => {
    expect(() => networkPrefix('not-a-cidr')).toThrow(BadRequestException);
  });
});

describe('gatewayAddress / hostAddress', () => {
  it('computes the gateway as host .1', () => {
    expect(gatewayAddress('10.8.0.0/24')).toBe('10.8.0.1/24');
  });

  it('computes a host address for the given octet', () => {
    expect(hostAddress('10.8.0.0/24', 5)).toBe('10.8.0.5');
  });
});

describe('nextCidr', () => {
  it('increments the third octet', () => {
    expect(nextCidr('10.9.1.0/24')).toBe('10.9.2.0/24');
  });

  it('wraps correctly across two-digit to three-digit octets', () => {
    expect(nextCidr('10.9.9.0/24')).toBe('10.9.10.0/24');
    expect(nextCidr('10.9.99.0/24')).toBe('10.9.100.0/24');
  });

  it('throws once the third octet is exhausted', () => {
    expect(() => nextCidr('10.9.255.0/24')).toThrow(BadRequestException);
  });
});

describe('classifyBypassEntry', () => {
  it('classifies a bare IPv4 address, defaulting to /32', () => {
    expect(classifyBypassEntry('1.2.3.4')).toEqual({ type: 'ip', value: '1.2.3.4/32' });
  });

  it('classifies an IPv4 CIDR as-is', () => {
    expect(classifyBypassEntry('1.2.3.0/24')).toEqual({ type: 'ip', value: '1.2.3.0/24' });
  });

  it('classifies a domain name, lower-cased', () => {
    expect(classifyBypassEntry('Api.Telegram.org')).toEqual({ type: 'domain', value: 'api.telegram.org' });
  });

  it('returns null for an empty/whitespace-only line', () => {
    expect(classifyBypassEntry('   ')).toBeNull();
  });

  it('returns null for an IPv4 address with an out-of-range octet', () => {
    expect(classifyBypassEntry('999.1.1.1')).toBeNull();
  });

  it('returns null for an unqualified single-label host', () => {
    expect(classifyBypassEntry('localhost')).toBeNull();
  });
});
