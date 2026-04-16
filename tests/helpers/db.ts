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
  // Enrolments reference users; clear those for non-seed users only.
  await pool.query(`
    DELETE FROM enrolments
     WHERE user_id IN (SELECT id FROM users WHERE username <> 'phase0_seed')
  `);
  await pool.query(`DELETE FROM users WHERE username <> 'phase0_seed'`);
}
