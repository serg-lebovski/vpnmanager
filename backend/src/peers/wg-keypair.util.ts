import { generateKeyPairSync, randomBytes } from 'crypto';

function base64UrlToBase64(input: string): string {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  return padded.replace(/-/g, '+').replace(/_/g, '/');
}

export interface WgKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateWgKeyPair(): WgKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privateJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return {
    publicKey: Buffer.from(base64UrlToBase64(publicJwk.x), 'base64').toString('base64'),
    privateKey: Buffer.from(base64UrlToBase64(privateJwk.d), 'base64').toString('base64'),
  };
}

export function generatePresharedKey(): string {
  return randomBytes(32).toString('base64');
}
