import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { PromptVersionRepo } from '../../src/repos/prompts.js';
import { PromptVersionService } from '../../src/services/prompts.js';
import { getSharedPool } from '../helpers/db.js';

const pool = getSharedPool();
const repo = new PromptVersionRepo(pool);

function uniqueName(): string {
  return `test_prompt_${randomBytes(4).toString('hex')}`;
}

const baseSchema = { type: 'object', additionalProperties: false, properties: {} };

describe('PromptVersionRepo', () => {
  it('inserts a draft row and reads it back', async () => {
    const name = uniqueName();
    const row = await repo.insert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'You are a marker.',
      outputSchema: baseSchema,
      status: 'draft',
    });
    expect(row.name).toBe(name);
    expect(row.version).toBe('v0.1.0');
    expect(row.status).toBe('draft');
    expect(row.output_schema).toEqual(baseSchema);

    const fetched = await repo.findByNameAndVersion(name, 'v0.1.0');
    expect(fetched?.id).toBe(row.id);
    expect(fetched?.system_prompt).toBe('You are a marker.');

    const byId = await repo.findById(row.id);
    expect(byId?.name).toBe(name);
  });

  it('allows multiple drafts per name but only one active row', async () => {
    const name = uniqueName();
    await repo.insert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'first draft',
      outputSchema: baseSchema,
      status: 'draft',
    });
    await repo.insert({
      name,
      version: 'v0.2.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'second draft',
      outputSchema: baseSchema,
      status: 'draft',
    });
    // Promote v0.1.0 to active manually (a migration will do this in prod).
    await pool.query(
      `UPDATE prompt_versions SET status = 'active' WHERE name = $1 AND version = $2`,
      [name, 'v0.1.0'],
    );
    const active = await repo.findActive(name);
    expect(active?.version).toBe('v0.1.0');

    // Flipping v0.2.0 to active while v0.1.0 is still active must fail.
    await expect(
      pool.query(`UPDATE prompt_versions SET status = 'active' WHERE name = $1 AND version = $2`, [
        name,
        'v0.2.0',
      ]),
    ).rejects.toThrow();
  });

  it('findActive returns null when no active row exists for the name', async () => {
    const name = uniqueName();
    await repo.insert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'draft',
      outputSchema: baseSchema,
      status: 'draft',
    });
    const active = await repo.findActive(name);
    expect(active).toBeNull();
  });

  it('upsert refreshes an existing row keyed on (name, version)', async () => {
    const name = uniqueName();
    await repo.upsert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'old body',
      outputSchema: baseSchema,
      status: 'draft',
    });
    const updated = await repo.upsert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'new body',
      outputSchema: baseSchema,
      status: 'draft',
    });
    expect(updated.system_prompt).toBe('new body');
    const all = await repo.listAll();
    const matches = all.filter((r) => r.name === name);
    expect(matches).toHaveLength(1);
  });
});

describe('PromptVersionService', () => {
  it('throws if getActive is called before loadActive', () => {
    const svc = new PromptVersionService(repo);
    expect(() => svc.getActive('anything')).toThrow(/loadActive/);
    expect(() => svc.listActive()).toThrow(/loadActive/);
  });

  it('loadActive populates the cache and getActive returns the active row', async () => {
    const name = uniqueName();
    await repo.insert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'active body',
      outputSchema: baseSchema,
      status: 'draft',
    });
    await pool.query(`UPDATE prompt_versions SET status = 'active' WHERE name = $1`, [name]);

    const svc = new PromptVersionService(repo);
    await svc.loadActive();
    const active = svc.getActive(name);
    expect(active?.system_prompt).toBe('active body');
    expect(svc.getActive('does-not-exist')).toBeNull();
  });

  it('listAll returns every row in the table', async () => {
    const name = uniqueName();
    await repo.insert({
      name,
      version: 'v0.1.0',
      modelId: 'gpt-5-mini',
      systemPrompt: 'body',
      outputSchema: baseSchema,
      status: 'draft',
    });
    const svc = new PromptVersionService(repo);
    const all = await svc.listAll();
    const names = all.map((r) => r.name);
    expect(names).toContain(name);
  });
});
