import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// scryptSync — намеренно CPU-тяжёлая KDF (это её смысл для паролей), но здесь она всего
// лишь выводит один и тот же ключ из статичного APP_ENCRYPTION_KEY, который не меняется в
// течение жизни процесса. Раньше пересчитывался заново на КАЖДЫЙ encrypt/decrypt — при
// опросе дашборда (расшифровка SSH-секрета на каждое подключение к каждому серверу) и
// списках peers/servers (needsRecreation/needsCredentials перебирают все секреты) это
// давало заметную постоянную нагрузку на CPU. Кэш безопасен: значение детерминировано и не
// зависит ни от чего, кроме уже проверенного APP_ENCRYPTION_KEY.
let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error('APP_ENCRYPTION_KEY is not set or too short');
  }
  cachedKey = scryptSync(secret, 'vpnmanager-static-salt', 32);
  return cachedKey;
}

export function encryptSecret(plainText: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptSecret(payload: string): string {
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Invalid encrypted payload format');
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
