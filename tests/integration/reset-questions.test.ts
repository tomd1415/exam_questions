import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { seedCuratedContent } from '../../src/scripts/seed-curated-content.js';
import { resetQuestions } from '../../src/scripts/reset-questions.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();

beforeEach(async () => {
  await cleanDb();
});

// resetQuestions legitimately wipes the Phase 0 seed question (stem starts
// "Inside the CPU..."), which later tests (migrate.test.ts, questions-repo,
// /q/:id HTTP tests) rely on — and they hard-code id='1'. So after each
// test, reset the questions_id sequence and replay migration 0007. The
// migration is idempotent and the TRUNCATE…RESTART IDENTITY guarantees the
// re-inserted seed row lands on id=1 again.
afterEach(async () => {
  await pool.query(`TRUNCATE TABLE questions RESTART IDENTITY CASCADE`);
  const sql = await readFile(
    path.resolve(process.cwd(), 'migrations/0007_seed_phase0_question.sql'),
    'utf8',
  );
  await pool.query(sql);
});

// cleanDb preserves the Phase 0 seed question (see tests/helpers/db.ts), so
// resetQuestions reports one extra row on top of whatever the test inserts.
// Capture the baseline once so expectations don't encode a magic "+1".
async function baselineQuestionCount(): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM questions`);
  return Number(rows[0]!.c);
}

function sampleQuestion(key: string): Record<string, unknown> {
  return {
    external_key: key,
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
    command_word_code: 'describe',
    archetype_code: 'explain',
    expected_response_type: 'short_text',
    stem: 'Describe the CPU.',
    model_answer:
      'The CPU fetches, decodes and executes instructions using the control unit and the ALU.',
    difficulty_band: 4,
    difficulty_step: 2,
    source_type: 'imported_pattern',
    parts: [
      {
        label: '(a)',
        prompt: 'Describe what the CPU does.',
        marks: 2,
        expected_response_type: 'short_text',
        mark_points: [
          { text: 'fetches instructions from memory', marks: 1 },
          { text: 'decodes and executes them', marks: 1 },
        ],
      },
    ],
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reset-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('resetQuestions (Chunk B3)', () => {
  it('wipes questions, drafts and attempts in a single transaction, then optionally reseeds', async () => {
    await withTempDir(async (dir) => {
      const baseline = await baselineQuestionCount();
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('reset-a')));
      await writeFile(path.join(dir, 'b.json'), JSON.stringify(sampleQuestion('reset-b')));

      // Seed once so there is real data to wipe.
      const first = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated-bot' },
        pool,
      );
      expect(first.created).toBe(2);

      // Insert a throwaway draft and an attempt so the reset has to clear
      // both side tables (and fail the FK RESTRICT between attempt_questions
      // and questions if the delete order is wrong).
      const teacher = await createUser(pool, { role: 'teacher' });
      const pupil = await createUser(pool, { role: 'pupil' });
      await pool.query(
        `INSERT INTO question_drafts (author_user_id, current_step, payload)
         VALUES ($1::bigint, 1, '{}'::jsonb)`,
        [teacher.id],
      );
      const cls = await pool.query<{ id: string }>(
        `INSERT INTO classes (name, teacher_id, academic_year)
         VALUES ('Reset test', $1::bigint, '2025/26') RETURNING id::text`,
        [teacher.id],
      );
      const attempt = await pool.query<{ id: string }>(
        `INSERT INTO attempts (user_id, class_id, mode, target_topic_code)
         VALUES ($1::bigint, $2::bigint, 'topic_set', '1.1')
         RETURNING id::text`,
        [pupil.id, cls.rows[0]!.id],
      );
      const q = await pool.query<{ id: string }>(`SELECT id::text FROM questions LIMIT 1`);
      await pool.query(
        `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
         VALUES ($1::bigint, $2::bigint, 0)`,
        [attempt.rows[0]!.id, q.rows[0]!.id],
      );

      const counts = await resetQuestions(pool, { seed: true, curatedDir: dir });
      // 2 curated + whatever was already there (the Phase 0 seed question).
      expect(counts.questions).toBe(2 + baseline);
      expect(counts.drafts).toBe(1);
      expect(counts.attempts).toBe(1);

      // After reset+seed, the two curated questions exist again; attempts
      // and drafts are gone.
      const qAfter = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM questions WHERE similarity_hash LIKE 'curated:%'`,
      );
      expect(Number(qAfter.rows[0]!.c)).toBe(2);
      const aAfter = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM attempts`);
      expect(Number(aAfter.rows[0]!.c)).toBe(0);
      const dAfter = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM question_drafts`,
      );
      expect(Number(dAfter.rows[0]!.c)).toBe(0);
    });
  });

  it('seed=false leaves the questions table empty', async () => {
    await withTempDir(async (dir) => {
      const baseline = await baselineQuestionCount();
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('reset-a')));
      await seedCuratedContent({ dir, dryRun: false, authorUsername: 'curated-bot' }, pool);

      const counts = await resetQuestions(pool, { seed: false });
      // 1 curated seeded + the pre-existing Phase 0 seed question (if any).
      expect(counts.questions).toBe(1 + baseline);

      const qAfter = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM questions`);
      expect(Number(qAfter.rows[0]!.c)).toBe(0);
    });
  });
});
