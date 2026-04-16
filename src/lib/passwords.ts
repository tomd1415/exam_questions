import { hash, verify, Algorithm } from '@node-rs/argon2';

const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, HASH_OPTIONS);
}

export function verifyPassword(plaintext: string, encoded: string): Promise<boolean> {
  return verify(encoded, plaintext);
}
