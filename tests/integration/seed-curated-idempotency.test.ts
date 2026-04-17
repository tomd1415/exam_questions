import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';
import { seedCuratedContent } from '../../src/scripts/seed-curated-content.js';

const pool = getSharedPool();

beforeEach(async () => {
  await cleanDb();
});

function sampleQuestion(key: string, stemSuffix = ''): Record<string, unknown> {
  return {
    external_key: key,
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
    command_word_code: 'describe',
    archetype_code: 'explain',
    expected_response_type: 'short_text',
    stem: `Describe the CPU.${stemSuffix}`,
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
  const dir = await mkdtemp(path.join(tmpdir(), 'curated-seed-idem-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedReferencingAttemptPart(questionId: string): Promise<{
  attemptId: string;
  attemptPartId: string;
  questionPartId: string;
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });

  const cls = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Idempotency test', $1::bigint, '2025/26') RETURNING id::text`,
    [teacher.id],
  );
  const classId = cls.rows[0]!.id;

  const qp = await pool.query<{ id: string }>(
    `SELECT id::text FROM question_parts WHERE question_id = $1::bigint ORDER BY display_order LIMIT 1`,
    [questionId],
  );
  const questionPartId = qp.rows[0]!.id;

  const att = await pool.query<{ id: string }>(
    `INSERT INTO attempts (user_id, class_id, mode, target_topic_code)
     VALUES ($1::bigint, $2::bigint, 'topic_set', '1.1') RETURNING id::text`,
    [pupil.id, classId],
  );
  const attemptId = att.rows[0]!.id;

  const aq = await pool.query<{ id: string }>(
    `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
     VALUES ($1::bigint, $2::bigint, 0) RETURNING id::text`,
    [attemptId, questionId],
  );

  const ap = await pool.query<{ id: string }>(
    `INSERT INTO attempt_parts (attempt_question_id, question_part_id)
     VALUES ($1::bigint, $2::bigint) RETURNING id::text`,
    [aq.rows[0]!.id, questionPartId],
  );

  return { attemptId, attemptPartId: ap.rows[0]!.id, questionPartId };
}

describe('seedCuratedContent — idempotency against referencing attempt_parts', () => {
  it('re-seeding identical content does not break when a live attempt references a question_part', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('idem-ref-1')));

      const first = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(first.created).toBe(1);
      expect(first.failed).toBe(0);

      const q = await pool.query<{ id: string }>(
        `SELECT id::text FROM questions WHERE similarity_hash = 'curated:idem-ref-1' LIMIT 1`,
      );
      const questionId = q.rows[0]!.id;

      const { questionPartId } = await seedReferencingAttemptPart(questionId);

      const second = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(second.failed).toBe(0);
      expect(second.updated).toBe(1);

      // The attempt_part still points at a live question_part (same id preferred,
      // but the essential invariant is that the referenced row still exists).
      const stillThere = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c
           FROM attempt_parts ap
           JOIN question_parts qp ON qp.id = ap.question_part_id
          WHERE qp.question_id = $1::bigint`,
        [questionId],
      );
      expect(Number(stillThere.rows[0]!.c)).toBe(1);

      // Specifically, the original question_part id should remain valid — the
      // seeder must not orphan or replace parts that live attempts depend on.
      const qpStillExists = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM question_parts WHERE id = $1::bigint`,
        [questionPartId],
      );
      expect(Number(qpStillExists.rows[0]!.c)).toBe(1);
    });
  });

  it('editing content re-seeds cleanly even when a live attempt references the old question_part', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('idem-ref-2')));

      const first = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(first.created).toBe(1);

      const q = await pool.query<{ id: string }>(
        `SELECT id::text FROM questions WHERE similarity_hash = 'curated:idem-ref-2' LIMIT 1`,
      );
      const questionId = q.rows[0]!.id;

      await seedReferencingAttemptPart(questionId);

      // Edit stem but keep same external_key.
      await writeFile(
        path.join(dir, 'a.json'),
        JSON.stringify(sampleQuestion('idem-ref-2', ' Clarified.')),
      );

      const second = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(second.failed).toBe(0);
      expect(second.updated).toBe(1);

      const stem = await pool.query<{ stem: string }>(
        `SELECT stem FROM questions WHERE id = $1::bigint`,
        [questionId],
      );
      expect(stem.rows[0]!.stem).toBe('Describe the CPU. Clarified.');

      // The live attempt_part is still connected to a question_part of this
      // question — editing curated content must not break references.
      const stillThere = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c
           FROM attempt_parts ap
           JOIN question_parts qp ON qp.id = ap.question_part_id
          WHERE qp.question_id = $1::bigint`,
        [questionId],
      );
      expect(Number(stillThere.rows[0]!.c)).toBe(1);
    });
  });
});
