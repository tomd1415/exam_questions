import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('design tokens stylesheet (Chunk 6a)', () => {
  it('/login links design-tokens.css before site.css', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    const tokensIdx = res.payload.indexOf('/static/design-tokens.css');
    const siteIdx = res.payload.indexOf('/static/site.css');
    expect(tokensIdx).toBeGreaterThan(-1);
    expect(siteIdx).toBeGreaterThan(-1);
    expect(tokensIdx).toBeLessThan(siteIdx);
  });

  it('the sign-in button carries a .btn--primary variant', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatch(
      /<button[^>]*type="submit"[^>]*class="[^"]*\bbtn\b[^"]*\bbtn--primary\b[^"]*"[^>]*>\s*Sign in/,
    );
  });
});
