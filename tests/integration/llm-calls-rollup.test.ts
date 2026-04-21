import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LlmCallRepo } from '../../src/repos/llm_calls.js';
import { PromptVersionRepo } from '../../src/repos/prompts.js';
import { FAMILY_B_OUTPUT_SCHEMA } from '../../src/services/prompts_bootstrap.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';

// Chunk 3g. The dashboard reads one GROUP BY per window, so the
// correctness we care about is: bucketing by prompt_version + model,
// window inclusivity, and independence from the `status` mix. The
// integration surface is tiny — we insert rows directly and assert
// the rollup.

const pool = getSharedPool();
const llmCallRepo = new LlmCallRepo(pool);
const promptRepo = new PromptVersionRepo(pool);

async function seedPrompt(name: string): Promise<{ id: string; name: string; version: string }> {
  const version = `v0.1.0-rollup-${randomBytes(3).toString('hex')}`;
  const row = await promptRepo.upsert({
    name,
    version,
    modelId: 'gpt-5-mini',
    systemPrompt: `test ${name}`,
    outputSchema: FAMILY_B_OUTPUT_SCHEMA,
    status: 'draft',
  });
  return { id: row.id, name: row.name, version: row.version };
}

async function insertAt(
  promptVersionId: string,
  modelId: string,
  when: Date,
  opts: {
    status?: 'ok' | 'refusal' | 'schema_invalid' | 'http_error' | 'timeout';
    inputTokens?: number;
    outputTokens?: number;
    costPence?: number;
  } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO llm_calls
       (prompt_version_id, attempt_part_id, model_id, input_tokens, output_tokens,
        cost_pence, latency_ms, status, error_message, created_at)
     VALUES ($1::bigint, NULL, $2, $3, $4, $5, 50, $6, NULL, $7)`,
    [
      promptVersionId,
      modelId,
      opts.inputTokens ?? 100,
      opts.outputTokens ?? 40,
      opts.costPence ?? 5,
      opts.status ?? 'ok',
      when,
    ],
  );
}

beforeEach(async () => {
  await cleanDb();
  await pool.query(`DELETE FROM llm_calls`);
  await pool.query(`DELETE FROM prompt_versions WHERE name LIKE 'rollup_%'`);
});

describe('LlmCallRepo.rollupBetween', () => {
  it('groups by prompt_version + model and sums over the window', async () => {
    const open = await seedPrompt('rollup_open');
    const code = await seedPrompt('rollup_code');

    const now = new Date('2026-04-21T12:00:00Z');
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // In-window rows.
    await insertAt(open.id, 'gpt-5-mini', new Date(now.getTime() - 1 * 60 * 60 * 1000), {
      inputTokens: 200,
      outputTokens: 80,
      costPence: 10,
      status: 'ok',
    });
    await insertAt(open.id, 'gpt-5-mini', new Date(now.getTime() - 2 * 60 * 60 * 1000), {
      inputTokens: 100,
      outputTokens: 30,
      costPence: 4,
      status: 'refusal',
    });
    await insertAt(code.id, 'gpt-5-mini', new Date(now.getTime() - 30 * 60 * 1000), {
      inputTokens: 300,
      outputTokens: 120,
      costPence: 15,
      status: 'ok',
    });

    // Out-of-window row (before start) — must not count.
    await insertAt(open.id, 'gpt-5-mini', new Date(start.getTime() - 60 * 60 * 1000), {
      inputTokens: 9999,
      outputTokens: 9999,
      costPence: 9999,
      status: 'ok',
    });
    // Out-of-window row (after end) — must not count.
    await insertAt(open.id, 'gpt-5-mini', new Date(now.getTime() + 60 * 60 * 1000), {
      inputTokens: 9999,
      outputTokens: 9999,
      costPence: 9999,
      status: 'ok',
    });

    const rows = await llmCallRepo.rollupBetween(start, now);
    expect(rows).toHaveLength(2);

    const byName = new Map(rows.map((r) => [r.prompt_name, r]));
    const openRow = byName.get('rollup_open')!;
    expect(openRow.calls).toBe(2);
    expect(openRow.ok_calls).toBe(1);
    expect(openRow.input_tokens).toBe(300);
    expect(openRow.output_tokens).toBe(110);
    expect(openRow.cost_pence).toBe(14);
    expect(openRow.model_id).toBe('gpt-5-mini');
    expect(openRow.prompt_version).toBe(open.version);

    const codeRow = byName.get('rollup_code')!;
    expect(codeRow.calls).toBe(1);
    expect(codeRow.ok_calls).toBe(1);
    expect(codeRow.cost_pence).toBe(15);

    // Ordered by cost descending — the code row (£0.15) must precede the open row (£0.14).
    expect(rows[0]!.prompt_name).toBe('rollup_code');
    expect(rows[1]!.prompt_name).toBe('rollup_open');
  });

  it('returns an empty list when no rows fall in the window', async () => {
    const open = await seedPrompt('rollup_open');
    const now = new Date('2026-04-21T12:00:00Z');
    await insertAt(open.id, 'gpt-5-mini', new Date('2026-01-01T00:00:00Z'));

    const start = new Date(now.getTime() - 60 * 60 * 1000);
    const rows = await llmCallRepo.rollupBetween(start, now);
    expect(rows).toEqual([]);
  });
});
