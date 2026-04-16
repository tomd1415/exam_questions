import pg from 'pg';

let sharedPool: pg.Pool | null = null;
const trackedPools: pg.Pool[] = [];

export function getTestDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL not set — global-setup did not run');
  }
  return url;
}

// One pool reused across all tests in a fork. Vitest runs all tests in a
// single fork (see vitest.config.ts) so this is safe and avoids exhausting
// connections.
export function getSharedPool(): pg.Pool {
  if (!sharedPool) {
    sharedPool = new pg.Pool({ connectionString: getTestDatabaseUrl(), max: 8 });
    trackedPools.push(sharedPool);
  }
  return sharedPool;
}

// Use this when a test needs an *additional* pool, e.g. to assert the
// migrate function works with a pool it owns. Caller must end() it.
export function createIsolatedPool(max = 2): pg.Pool {
  const p = new pg.Pool({ connectionString: getTestDatabaseUrl(), max });
  trackedPools.push(p);
  return p;
}

export async function endAllPools(): Promise<void> {
  await Promise.all(trackedPools.map((p) => p.end().catch(() => undefined)));
  trackedPools.length = 0;
  sharedPool = null;
}

// Truncate volatile tables and remove any non-seed users between tests.
// Curriculum, the seeded phase0_seed user, the demo class, and the seed
// question are preserved (those came from migrations and are needed by
// the question routes).
export async function cleanDb(pool: pg.Pool = getSharedPool()): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      audit_events,
      attempt_parts,
      attempt_questions,
      attempts,
      sessions
    RESTART IDENTITY CASCADE
  `);
  // No seeded enrolments exist (per 0007_seed_phase0_question.sql), so wipe
  // all of them — tests own everything in this table.
  await pool.query(`DELETE FROM enrolments`);
  // Drop classes owned by non-seed teachers (i.e. test-created ones); the
  // 'Phase 0 Demo' class belongs to phase0_seed and survives.
  await pool.query(`
    DELETE FROM classes
     WHERE teacher_id <> (SELECT id FROM users WHERE username = 'phase0_seed')
  `);
  // Drop questions authored by non-seed teachers; question_parts, mark_points
  // and part-level common_misconceptions cascade. The Phase 0 seed question
  // (created_by = phase0_seed) survives, as do topic-level misconceptions.
  await pool.query(`
    DELETE FROM questions
     WHERE created_by <> (SELECT id FROM users WHERE username = 'phase0_seed')
  `);
  await pool.query(`DELETE FROM users WHERE username <> 'phase0_seed'`);
}
