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
