const ORIGINAL_KEY = process.env.APP_ENCRYPTION_KEY;
const VALID_KEY = 'a-valid-test-key-1234567890';

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe('encryptSecret/decryptSecret', () => {
  it('throws if APP_ENCRYPTION_KEY is missing', () => {
    jest.resetModules();
    delete process.env.APP_ENCRYPTION_KEY;
    const { encryptSecret } = require('./encryption.util');
    expect(() => encryptSecret('hello')).toThrow('APP_ENCRYPTION_KEY');
  });

  it('throws if APP_ENCRYPTION_KEY is shorter than 16 characters', () => {
    jest.resetModules();
    process.env.APP_ENCRYPTION_KEY = 'too-short';
    const { encryptSecret } = require('./encryption.util');
    expect(() => encryptSecret('hello')).toThrow('APP_ENCRYPTION_KEY');
  });

  it('round-trips a plaintext value', () => {
    jest.resetModules();
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    const { encryptSecret, decryptSecret } = require('./encryption.util');
    const cipherText = encryptSecret('super-secret-value');
    expect(decryptSecret(cipherText)).toBe('super-secret-value');
  });

  it('stores ciphertext as iv:authTag:data hex triplet', () => {
    jest.resetModules();
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    const { encryptSecret } = require('./encryption.util');
    const parts = encryptSecret('value').split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('uses a random IV so identical plaintexts produce different ciphertext', () => {
    jest.resetModules();
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    const { encryptSecret } = require('./encryption.util');
    expect(encryptSecret('same-value')).not.toBe(encryptSecret('same-value'));
  });

  it('throws on a malformed payload', () => {
    jest.resetModules();
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    const { decryptSecret } = require('./encryption.util');
    expect(() => decryptSecret('not-a-valid-payload')).toThrow('Invalid encrypted payload format');
  });

  it('throws when the ciphertext was tampered with (auth tag mismatch)', () => {
    jest.resetModules();
    process.env.APP_ENCRYPTION_KEY = VALID_KEY;
    const { encryptSecret, decryptSecret } = require('./encryption.util');
    const [iv, authTag, data] = encryptSecret('value').split(':');
    const tampered = [iv, authTag, data.slice(0, -2) + (data.slice(-2) === '00' ? '11' : '00')].join(':');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
