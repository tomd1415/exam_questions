import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { getSharedPool } from './db.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ pool: getSharedPool(), logger: false });
  await app.ready();
  return app;
}
