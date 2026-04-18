import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cleanDb, getSharedPool, getTestDatabaseUrl } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

const SCRIPT = resolve(process.cwd(), 'scripts/migrate/0019-trace-table-backfill.ts');
const TSX = resolve(process.cwd(), 'node_modules/.bin/tsx');

beforeEach(async () => {
  await cleanDb();
});

function runBackfill(extraEnv: Record<string, string> = {}, args: readonly string[] = []): string {
  return execFileSync(TSX, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: getTestDatabaseUrl(),
      ...extraEnv,
    },
    cwd: process.cwd(),
  });
}

describe('0019-trace-table-backfill', () => {
  it('seeds a placeholder grid into legacy NULL-config trace_table parts', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.1',
      subtopicCode: '2.1.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Legacy.',
      expectedResponseType: 'trace_table',
      parts: [
        {
          label: '(a)',
          prompt: 'Trace.',
          marks: 3,
          expectedResponseType: 'trace_table',
        },
      ],
    });

    const out = runBackfill();
    expect(out).toMatch(/migrated 1 row\(s\)/);

    const { rows } = await pool.query<{ part_config: unknown }>(
      `SELECT part_config FROM question_parts WHERE expected_response_type = 'trace_table'`,
    );
    expect(rows).toHaveLength(1);
    const cfg = rows[0]!.part_config as Record<string, unknown>;
    expect(cfg).toMatchObject({
      columns: expect.any(Array),
      rows: expect.any(Number),
      expected: {},
      marking: { mode: 'perCell' },
    });
  });

  it('is idempotent — re-running on already-shaped rows skips them', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.1',
      subtopicCode: '2.1.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Already shaped.',
      expectedResponseType: 'trace_table',
      parts: [
        {
          label: '(a)',
          prompt: 'Trace.',
          marks: 2,
          expectedResponseType: 'trace_table',
          partConfig: {
            columns: [{ name: 'i' }],
            rows: 1,
            expected: { '0,0': '1' },
            marking: { mode: 'perCell' },
          },
        },
      ],
    });

    const out = runBackfill();
    expect(out).toMatch(/migrated 0 row\(s\); skipped 1/);
  });

  it('--dry-run reports what would change without writing', async () => {
    const pool = getSharedPool();
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, {
      componentCode: 'J277/02',
      topicCode: '2.1',
      subtopicCode: '2.1.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Dry.',
      expectedResponseType: 'trace_table',
      parts: [
        {
          label: '(a)',
          prompt: 'Trace.',
          marks: 1,
          expectedResponseType: 'trace_table',
        },
      ],
    });

    const out = runBackfill({}, ['--dry-run']);
    expect(out).toMatch(/DRY RUN — would migrate 1 row\(s\)/);

    const { rows } = await pool.query<{ part_config: unknown }>(
      `SELECT part_config FROM question_parts WHERE expected_response_type = 'trace_table'`,
    );
    expect(rows[0]!.part_config).toBeNull();
  });
});
