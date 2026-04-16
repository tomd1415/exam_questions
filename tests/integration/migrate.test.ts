import { describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createIsolatedPool, getSharedPool } from '../helpers/db.js';

describe('runMigrations', () => {
  it('is idempotent — re-running applies zero new migrations', async () => {
    const pool = createIsolatedPool();
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBeGreaterThan(0);
    await pool.end();
  });

  it('records every applied migration in schema_migrations', async () => {
    const { rows } = await getSharedPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM schema_migrations`,
    );
    // We have 7 migrations checked into migrations/.
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(7);
  });

  it('seeded the curriculum invariants used by the restore drill', async () => {
    const pool = getSharedPool();
    const components = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM components`,
    );
    const topics = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM topics`,
    );
    const subtopics = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM subtopics`,
    );
    const cmd = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM command_words`,
    );
    expect(Number(components.rows[0]!.count)).toBe(2);
    expect(Number(topics.rows[0]!.count)).toBe(11);
    expect(Number(subtopics.rows[0]!.count)).toBe(26);
    expect(Number(cmd.rows[0]!.count)).toBe(29);
  });

  it('seeded the Phase 0 demo question + class + seeder user', async () => {
    const pool = getSharedPool();
    const seeder = await pool.query(`SELECT id FROM users WHERE username = 'phase0_seed'`);
    expect(seeder.rowCount).toBe(1);

    const cls = await pool.query(`SELECT id FROM classes WHERE name = 'Phase 0 Demo'`);
    expect(cls.rowCount).toBe(1);

    const q = await pool.query(
      `SELECT id FROM questions WHERE stem = 'Inside the CPU is the Arithmetic Logic Unit (ALU).'`,
    );
    expect(q.rowCount).toBe(1);
  });
});
