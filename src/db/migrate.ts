import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pool } from './pool.js';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');
const MIGRATION_PATTERN = /^(\d{4})_[\w-]+\.sql$/;

interface PendingMigration {
  version: string;
  filename: string;
  body: string;
}

async function listMigrationsOnDisk(): Promise<PendingMigration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const matched = entries
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b));
  const out: PendingMigration[] = [];
  for (const filename of matched) {
    const match = MIGRATION_PATTERN.exec(filename);
    if (!match) continue;
    const version = match[1]!;
    const body = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    out.push({ version, filename, body });
  }
  return out;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedVersions(): Promise<Set<string>> {
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function applyMigration(m: PendingMigration): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.body);
    await client.query('INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)', [
      m.version,
      m.filename,
    ]);
    await client.query('COMMIT');
    console.log(`  applied ${m.filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await ensureMigrationsTable();
  const onDisk = await listMigrationsOnDisk();
  const applied = await appliedVersions();
  const pending = onDisk.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log(`No pending migrations. ${applied.size} already applied.`);
    return;
  }

  console.log(`Applying ${pending.length} migration(s):`);
  for (const m of pending) {
    await applyMigration(m);
  }
  console.log('Done.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('Migration failed:', err);
    await pool.end();
    process.exit(1);
  });
