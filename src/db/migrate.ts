import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { pool as defaultPool } from './pool.js';

const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');
const MIGRATION_PATTERN = /^(\d{4})_[\w-]+\.sql$/;

interface PendingMigration {
  version: string;
  filename: string;
  body: string;
}

async function listMigrationsOnDisk(dir: string): Promise<PendingMigration[]> {
  const entries = await readdir(dir);
  const matched = entries
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b));
  const out: PendingMigration[] = [];
  for (const filename of matched) {
    const match = MIGRATION_PATTERN.exec(filename);
    if (!match) continue;
    const version = match[1]!;
    const body = await readFile(join(dir, filename), 'utf8');
    out.push({ version, filename, body });
  }
  return out;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedVersions(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function applyMigration(
  pool: Pool,
  m: PendingMigration,
  log: (msg: string) => void,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.body);
    await client.query('INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)', [
      m.version,
      m.filename,
    ]);
    await client.query('COMMIT');
    log(`  applied ${m.filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface RunMigrationsOptions {
  dir?: string;
  log?: (msg: string) => void;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  const log = options.log ?? ((): void => undefined);

  await ensureMigrationsTable(pool);
  const onDisk = await listMigrationsOnDisk(dir);
  const applied = await appliedVersions(pool);
  const pending = onDisk.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    log(`No pending migrations. ${String(applied.size)} already applied.`);
    return { applied: [], alreadyApplied: applied.size };
  }

  log(`Applying ${String(pending.length)} migration(s):`);
  const appliedNow: string[] = [];
  for (const m of pending) {
    await applyMigration(pool, m, log);
    appliedNow.push(m.filename);
  }
  log('Done.');
  return { applied: appliedNow, alreadyApplied: applied.size };
}

async function main(): Promise<void> {
  await runMigrations(defaultPool, { log: (msg) => console.log(msg) });
}

const invokedAs = process.argv[1];
const isCli = invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href;
if (isCli) {
  main()
    .then(() => defaultPool.end())
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await defaultPool.end();
      process.exit(1);
    });
}
