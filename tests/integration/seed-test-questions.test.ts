import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { seedTestQuestions } from '../../src/scripts/seed-test-questions.js';

const pool = getSharedPool();

beforeEach(async () => {
  await cleanDb();
});

// seedTestQuestions writes a large batch of questions tagged with
// similarity_hash 'test:%'. Other suites rely on the Phase 0 seed row at
// questions.id = 1, so restore it after each test (same pattern as
// reset-questions.test.ts).
afterEach(async () => {
  await pool.query(`TRUNCATE TABLE questions RESTART IDENTITY CASCADE`);
  const sql = await readFile(
    path.resolve(process.cwd(), 'migrations/0007_seed_phase0_question.sql'),
    'utf8',
  );
  await pool.query(sql);
});

const baseOpts = {
  pupilUsername: 'test_pupil_vt',
  teacherUsername: 'test_teacher_vt',
  className: 'Widget Test Harness (vitest)',
  academicYear: '2025-26',
  topicCode: '1.1',
  subtopicCode: '1.1.1',
  componentCode: 'J277/01',
  dryRun: false,
  reset: false,
};

describe('seedTestQuestions', () => {
  it('validates all 34 questions under --dry-run', async () => {
    const summary = await seedTestQuestions({ ...baseOpts, dryRun: true }, pool);
    expect(summary.errors).toStrictEqual([]);
    expect(summary.failed).toBe(0);
    expect(summary.scanned).toBe(summary.created + summary.updated);
    expect(summary.scanned).toBeGreaterThanOrEqual(34);
  });

  it('seeds every widget type once and builds a pre-loaded attempt for the test pupil', async () => {
    const summary = await seedTestQuestions(baseOpts, pool);
    expect(summary.failed).toBe(0);
    expect(summary.created).toBe(summary.scanned);
    expect(summary.attemptId).not.toBeNull();
    expect(summary.pupilLogin?.username).toBe(baseOpts.pupilUsername);

    const { rows: distinctTypes } = await pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT expected_response_type)::text AS n
         FROM questions WHERE similarity_hash LIKE 'test:%'`,
    );
    expect(Number(distinctTypes[0]!.n)).toBeGreaterThanOrEqual(17);

    const { rows: countByType } = await pool.query<{ t: string; n: string }>(
      `SELECT expected_response_type AS t, COUNT(*)::text AS n
         FROM questions WHERE similarity_hash LIKE 'test:%'
         GROUP BY expected_response_type
         ORDER BY expected_response_type`,
    );
    for (const row of countByType) expect(Number(row.n)).toBe(2);

    const { rows: aq } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM attempt_questions WHERE attempt_id = $1::bigint`,
      [summary.attemptId],
    );
    expect(Number(aq[0]!.n)).toBe(summary.scanned + summary.curatedAttached);

    const { rows: inactive } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM questions WHERE similarity_hash LIKE 'test:%' AND active = true`,
    );
    expect(Number(inactive[0]!.n)).toBe(0);
  });

  it('is idempotent — running twice updates in place rather than duplicating', async () => {
    const first = await seedTestQuestions(baseOpts, pool);
    const second = await seedTestQuestions(baseOpts, pool);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(first.scanned);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM questions WHERE similarity_hash LIKE 'test:%'`,
    );
    expect(Number(rows[0]!.n)).toBe(first.scanned);
  });
});
