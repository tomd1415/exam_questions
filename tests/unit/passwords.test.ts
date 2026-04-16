import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/passwords.js';

describe('passwords', () => {
  it('hashes to an argon2id-shaped string', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    // argon2 encoded format includes algorithm, version, params, salt, hash
    expect(hash.split('$').length).toBeGreaterThanOrEqual(6);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('letmein-12345');
    await expect(verifyPassword('letmein-12345', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('letmein-12345');
    await expect(verifyPassword('letmein-12346', hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same input (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('rejects when given a non-argon2 hash', async () => {
    await expect(verifyPassword('foo', 'not-a-valid-hash')).rejects.toThrow();
  });
});
