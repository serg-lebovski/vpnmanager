import { BadRequestException } from '@nestjs/common';

// В первом билде поддерживаются только сети вида a.b.c.0/24 — этого достаточно
// для peer-to-peer VPN (до 253 клиентов на интерфейс) и упрощает выделение IP.
export function assertSupportedCidr(cidr: string): void {
  const match = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/);
  if (!match) {
    throw new BadRequestException('Поддерживаются только сети вида a.b.c.0/24');
  }
}

export function networkPrefix(cidr: string): string {
  const match = cidr.match(/^(\d+\.\d+\.\d+)\.0\/24$/);
  if (!match) {
    throw new BadRequestException('Некорректный network CIDR');
  }
  return match[1];
}

export function gatewayAddress(cidr: string): string {
  return `${networkPrefix(cidr)}.1/24`;
}

export function hostAddress(cidr: string, hostOctet: number): string {
  return `${networkPrefix(cidr)}.${hostOctet}`;
}

// Список обхода upstream моста (Bridge.bypassDestinations) — каждая строка либо IPv4/CIDR,
// либо доменное имя (домены резолвятся отдельно, на self-сервере, см.
// VpnProvisioningService.setupBridgeBypass). Возвращает null для явно некорректных строк —
// вызывающий код (BridgesService.update) сам решает, как на это реагировать.
export type BypassDestination = { type: 'ip'; value: string } | { type: 'domain'; value: string };

const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/;
const HOSTNAME_RE = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))+$/;

export function classifyBypassEntry(raw: string): BypassDestination | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const ipMatch = value.match(IPV4_CIDR_RE);
  if (ipMatch) {
    const octets = [ipMatch[1], ipMatch[2], ipMatch[3], ipMatch[4]].map(Number);
    const prefix = ipMatch[6] !== undefined ? Number(ipMatch[6]) : 32;
    if (octets.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32) {
      return { type: 'ip', value: `${ipMatch[1]}.${ipMatch[2]}.${ipMatch[3]}.${ipMatch[4]}/${prefix}` };
    }
    return null;
  }
  if (value.length <= 253 && HOSTNAME_RE.test(value)) {
    return { type: 'domain', value: value.toLowerCase() };
  }
  return null;
}
