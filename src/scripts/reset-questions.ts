/**
 * Reset all questions + attempt history, then (optionally) reseed.
 *
 *   npm run content:reset                    -- confirm required
 *   npm run content:reset -- --yes           -- skip the y/N prompt
 *   npm run content:reset -- --yes --no-seed -- wipe only, no reseed
 *
 * Intended for the test-data phase of the project: the user's dev box
 * and the school LAN VM both carry throwaway content. On a real tenant
 * with pupil submissions worth keeping, do NOT run this — delete the
 * attempts you no longer want via SQL instead.
 *
 * Order of deletion respects the FK graph:
 *   attempts (CASCADE to attempt_questions, attempt_question_parts)
 *   question_drafts
 *   questions (CASCADE to question_parts, question_mark_points, misconceptions)
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/pool.js';
import { seedCuratedContent } from './seed-curated-content.js';

interface ResetOptions {
  yes: boolean;
  seed: boolean;
  curatedDir: string;
}

interface ResetCounts {
  attempts: number;
  questions: number;
  drafts: number;
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      'This will delete ALL attempts, questions, and question drafts. Continue? [y/N] ',
    );
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export async function resetQuestions(
  pool: Pool,
  opts: { seed?: boolean; curatedDir?: string } = {},
): Promise<ResetCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Count before delete so the caller can report a useful summary even
    // when the cascades mean we only issue three statements.
    const aCount = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM attempts');
    const qCount = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM questions');
    const dCount = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM question_drafts',
    );

    await client.query('DELETE FROM attempts');
    await client.query('DELETE FROM question_drafts');
    await client.query('DELETE FROM questions');

    await client.query('COMMIT');

    const counts: ResetCounts = {
      attempts: Number(aCount.rows[0]!.n),
      questions: Number(qCount.rows[0]!.n),
      drafts: Number(dCount.rows[0]!.n),
    };

    if (opts.seed !== false) {
      await seedCuratedContent(
        {
          dir: opts.curatedDir ?? 'content/curated',
          dryRun: false,
          authorUsername: 'curated-bot',
        },
        pool,
      );
    }
    return counts;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      yes: { type: 'boolean', default: false },
      'no-seed': { type: 'boolean', default: false },
      dir: { type: 'string', default: 'content/curated' },
    },
  });
  const opts: ResetOptions = {
    yes: values.yes === true,
    seed: values['no-seed'] !== true,
    curatedDir: values.dir ?? 'content/curated',
  };

  if (!opts.yes) {
    const ok = await confirm();
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  const counts = await resetQuestions(defaultPool, {
    seed: opts.seed,
    curatedDir: opts.curatedDir,
  });
  console.log(
    `Deleted: attempts=${counts.attempts} question_drafts=${counts.drafts} questions=${counts.questions}`,
  );
  if (opts.seed) {
    console.log(`Reseeded from ${opts.curatedDir}`);
  }
}

// Invoked from the CLI (npm run content:reset). Mirrors the pattern used
// by seed-curated-content.ts.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('reset-questions.ts') === true;

if (isMain) {
  main()
    .then(() => defaultPool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
