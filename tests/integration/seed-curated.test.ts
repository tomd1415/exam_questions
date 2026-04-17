import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanDb, getSharedPool } from '../helpers/db.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'curated-seed-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('seedCuratedContent', () => {
  it('creates questions on first run and is a no-op on second run (updated rows remain 1)', async () => {
    await withTempDir(async (dir) => {
      const q1 = sampleQuestion('int-1');
      const q2 = sampleQuestion('int-2');
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(q1));
      await writeFile(path.join(dir, 'b.json'), JSON.stringify(q2));

      const first = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(first.scanned).toBe(2);
      expect(first.created).toBe(2);
      expect(first.updated).toBe(0);
      expect(first.failed).toBe(0);

      const countRes = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM questions WHERE similarity_hash LIKE 'curated:%'`,
      );
      expect(Number(countRes.rows[0]!.c)).toBe(2);

      const second = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(second.created).toBe(0);
      expect(second.updated).toBe(2);
      expect(second.failed).toBe(0);

      const countAfter = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM questions WHERE similarity_hash LIKE 'curated:%'`,
      );
      expect(Number(countAfter.rows[0]!.c)).toBe(2);
    });
  });

  it('editing one file updates only that question', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('int-a')));
      await writeFile(path.join(dir, 'b.json'), JSON.stringify(sampleQuestion('int-b')));
      await seedCuratedContent({ dir, dryRun: false, authorUsername: 'curated_seed' }, pool);

      const before = await pool.query<{ stem: string; similarity_hash: string }>(
        `SELECT stem, similarity_hash FROM questions WHERE similarity_hash = 'curated:int-a' LIMIT 1`,
      );
      expect(before.rows[0]!.stem).toBe('Describe the CPU.');

      const edited = sampleQuestion('int-a', ' Clarified.');
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(edited));

      const run = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(run.updated).toBe(2);
      expect(run.created).toBe(0);

      const after = await pool.query<{ stem: string }>(
        `SELECT stem FROM questions WHERE similarity_hash = 'curated:int-a' LIMIT 1`,
      );
      expect(after.rows[0]!.stem).toBe('Describe the CPU. Clarified.');
      const bRow = await pool.query<{ stem: string }>(
        `SELECT stem FROM questions WHERE similarity_hash = 'curated:int-b' LIMIT 1`,
      );
      expect(bRow.rows[0]!.stem).toBe('Describe the CPU.');
    });
  });

  it('marks seeded questions approved + active with the seeder as created_by and approved_by', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('int-approved')));
      await seedCuratedContent({ dir, dryRun: false, authorUsername: 'curated_seed' }, pool);

      const row = await pool.query<{
        approval_status: string;
        active: boolean;
        created_username: string;
        approved_username: string | null;
      }>(
        `SELECT q.approval_status, q.active,
                u1.username AS created_username,
                u2.username AS approved_username
           FROM questions q
           JOIN users u1 ON u1.id = q.created_by
           LEFT JOIN users u2 ON u2.id = q.approved_by
          WHERE q.similarity_hash = 'curated:int-approved'
          LIMIT 1`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.approval_status).toBe('approved');
      expect(row.rows[0]!.active).toBe(true);
      expect(row.rows[0]!.created_username).toBe('curated_seed');
      expect(row.rows[0]!.approved_username).toBe('curated_seed');
    });
  });

  it('reports schema failures without writing a row', async () => {
    await withTempDir(async (dir) => {
      const bad = sampleQuestion('int-bad');
      (bad as { parts: { mark_points: unknown[] }[] }).parts[0]!.mark_points = [];
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(bad));

      const result = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0]!.message).toMatch(/schema/);

      const count = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM questions WHERE similarity_hash = 'curated:int-bad'`,
      );
      expect(Number(count.rows[0]!.c)).toBe(0);
    });
  });

  it('detects duplicate external_key across two files in the same run', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('int-dup')));
      await writeFile(path.join(dir, 'b.json'), JSON.stringify(sampleQuestion('int-dup', ' B')));

      const result = await seedCuratedContent(
        { dir, dryRun: false, authorUsername: 'curated_seed' },
        pool,
      );
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.errors.some((e) => e.message.includes('duplicate external_key'))).toBe(true);
    });
  });

  it('dry-run validates without writing', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'a.json'), JSON.stringify(sampleQuestion('int-dry')));
      const result = await seedCuratedContent(
        { dir, dryRun: true, authorUsername: 'curated_seed' },
        pool,
      );
      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);

      const count = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM questions WHERE similarity_hash = 'curated:int-dry'`,
      );
      expect(Number(count.rows[0]!.c)).toBe(0);
    });
  });
});
