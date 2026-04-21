import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

let app: FastifyInstance;
const pool = getSharedPool();

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  await cleanDb();
  await pool.query(`DELETE FROM llm_calls`);
  await pool.query(`DELETE FROM prompt_versions WHERE name LIKE 'dash_%'`);
});

afterAll(async () => {
  await app.close();
});

function form(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function loginAs(user: CreatedUser): Promise<ReturnType<typeof newJar>> {
  const jar = newJar();
  const loginGet = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, loginGet);
  const token = extractCsrfToken(loginGet.payload);
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ username: user.username, password: user.password, _csrf: token }),
  });
  expect(res.statusCode).toBe(302);
  updateJar(jar, res);
  return jar;
}

async function seedPromptRow(name: string): Promise<string> {
  const version = `v0.1.0-dash-${randomBytes(3).toString('hex')}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO prompt_versions (name, version, model_id, system_prompt, output_schema, status)
     VALUES ($1, $2, 'gpt-5-mini', 'test prompt', '{}'::jsonb, 'draft')
     RETURNING id::text`,
    [name, version],
  );
  return rows[0]!.id;
}

async function insertCall(
  promptVersionId: string,
  when: Date,
  costPence: number,
  status: 'ok' | 'refusal' | 'schema_invalid' | 'http_error' | 'timeout' = 'ok',
): Promise<void> {
  await pool.query(
    `INSERT INTO llm_calls
       (prompt_version_id, attempt_part_id, model_id, input_tokens, output_tokens,
        cost_pence, latency_ms, status, error_message, created_at)
     VALUES ($1::bigint, NULL, 'gpt-5-mini', 100, 40, $2, 42, $3, NULL, $4)`,
    [promptVersionId, costPence, status, when],
  );
}

describe('GET /admin/llm/costs', () => {
  it('redirects anonymous users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/llm/costs' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('forbids a pupil', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/llm/costs',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a teacher (admin-only)', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/llm/costs',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders both cards with zero spend for admin when there are no calls', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/llm/costs',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('LLM costs');
    expect(res.payload).toContain('Last 7 days');
    expect(res.payload).toContain('Month to date');
    expect(res.payload).toContain('£0.00');
    expect(res.payload).toContain('No LLM calls in this window');
    // Zero spend → green band.
    expect(res.payload).toContain('llm-cost-card--green');
  });

  it('sums per prompt in the last-7-days card and shows pounds', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const promptA = await seedPromptRow('dash_open');
    const promptB = await seedPromptRow('dash_code');

    const now = new Date();
    const hour = 60 * 60 * 1000;
    await insertCall(promptA, new Date(now.getTime() - 1 * hour), 120, 'ok');
    await insertCall(promptA, new Date(now.getTime() - 2 * hour), 80, 'refusal');
    await insertCall(promptB, new Date(now.getTime() - 3 * hour), 300, 'ok');

    const res = await app.inject({
      method: 'GET',
      url: '/admin/llm/costs',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('dash_open');
    expect(res.payload).toContain('dash_code');
    // £1.20 + £0.80 = £2.00 for dash_open; £3.00 for dash_code; total = £5.00
    expect(res.payload).toContain('£5.00');
    expect(res.payload).toContain('£3.00'); // dash_code
    expect(res.payload).toContain('£2.00'); // dash_open
  });

  it('bands the card red when projected spend exceeds 1.2× the budget', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const promptId = await seedPromptRow('dash_open');

    // Put £50 spend in the last hour — projection over 30 days will
    // dwarf any reasonable budget and lock the band to red.
    const now = new Date();
    await insertCall(promptId, new Date(now.getTime() - 30 * 60 * 1000), 5000, 'ok');

    const res = await app.inject({
      method: 'GET',
      url: '/admin/llm/costs',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('llm-cost-card--red');
    expect(res.payload).toContain('pill--danger');
  });
});
