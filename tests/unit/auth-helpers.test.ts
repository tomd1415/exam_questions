import { describe, it, expect } from 'vitest';
import { hashIp } from '../../src/services/auth.js';

describe('hashIp', () => {
  it('produces a 64-character hex digest', () => {
    const out = hashIp('203.0.113.5', 'salt-A');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same (ip, salt)', () => {
    expect(hashIp('203.0.113.5', 'salt-A')).toBe(hashIp('203.0.113.5', 'salt-A'));
  });

  it('changes when the IP changes', () => {
    expect(hashIp('203.0.113.5', 'salt-A')).not.toBe(hashIp('203.0.113.6', 'salt-A'));
  });

  it('changes when the salt changes', () => {
    expect(hashIp('203.0.113.5', 'salt-A')).not.toBe(hashIp('203.0.113.5', 'salt-B'));
  });
});
