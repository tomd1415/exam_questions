import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://exam:exam@localhost:5433/postgres';

function adminUrlFor(database: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
}

export default async function setup(): Promise<() => Promise<void>> {
  const dbName = `exam_test_${randomBytes(6).toString('hex')}`;
  const adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${dbName}`);
  await adminClient.end();

  const setupClient = new pg.Client({ connectionString: adminUrlFor(dbName) });
  await setupClient.connect();
  await setupClient.query('CREATE EXTENSION IF NOT EXISTS vector');
  await setupClient.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await setupClient.query('CREATE EXTENSION IF NOT EXISTS citext');
  await setupClient.end();

  const migratePool = new pg.Pool({ connectionString: adminUrlFor(dbName), max: 2 });
  await runMigrations(migratePool, { dir: resolve(process.cwd(), 'migrations') });
  await migratePool.end();

  process.env['TEST_DATABASE_URL'] = adminUrlFor(dbName);

  return async function teardown(): Promise<void> {
    const dropClient = new pg.Client({ connectionString: ADMIN_URL });
    await dropClient.connect();
    // Force-disconnect anything still on this DB before DROP.
    await dropClient.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await dropClient.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await dropClient.end();
  };
}
