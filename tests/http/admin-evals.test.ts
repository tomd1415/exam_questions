import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';
import { buildReport, writeReport } from '../../src/services/eval/report.js';
import type { FixtureResult, PromptAggregate } from '../../src/services/eval/scoring.js';

let app: FastifyInstance;
const pool = getSharedPool();
let outDir: string;
const ORIG_OUT_DIR = process.env['EVAL_OUT_DIR'];

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  if (ORIG_OUT_DIR === undefined) delete process.env['EVAL_OUT_DIR'];
  else process.env['EVAL_OUT_DIR'] = ORIG_OUT_DIR;
});

beforeEach(async () => {
  await cleanDb();
  outDir = mkdtempSync(path.join(tmpdir(), 'eval-http-'));
  process.env['EVAL_OUT_DIR'] = outDir;
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
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

function passingResult(overrides: Partial<FixtureResult> = {}): FixtureResult {
  return {
    fixtureId: 'open_pass',
    description: 'all marks',
    promptName: 'mark_open_response',
    promptVersion: 'v0.1.0',
    outcomeKind: 'awarded',
    marksAwarded: 2,
    expectedRange: [2, 2],
    absoluteError: 0,
    hitIds: ['mp_1', 'mp_2'],
    missedIds: [],
    missingRequiredHits: [],
    unexpectedHits: [],
    refused: false,
    refusalExpected: false,
    passed: true,
    failReasons: [],
    latencyMs: 200,
    costPence: 4,
    ...overrides,
  };
}

function failingResult(overrides: Partial<FixtureResult> = {}): FixtureResult {
  return passingResult({
    fixtureId: 'open_fail',
    description: 'marker under-awarded',
    marksAwarded: 0,
    absoluteError: 2,
    passed: false,
    failReasons: ['marks 0 outside expected range [2, 2]'],
    ...overrides,
  });
}

function greenAggregate(): PromptAggregate {
  return {
    promptName: 'mark_open_response',
    promptVersion: 'v0.1.0',
    fixtures: 2,
    passed: 2,
    failed: 0,
    passRate: 1,
    meanAbsoluteError: 0,
    totalCostPence: 8,
    meanLatencyMs: 200,
    worstOffenders: [],
  };
}

function redAggregate(): PromptAggregate {
  const fail = failingResult();
  return {
    promptName: 'mark_code_response',
    promptVersion: 'v0.1.0',
    fixtures: 2,
    passed: 1,
    failed: 1,
    passRate: 0.5,
    meanAbsoluteError: 1,
    totalCostPence: 10,
    meanLatencyMs: 300,
    worstOffenders: [fail],
  };
}

describe('GET /admin/evals/latest', () => {
  it('redirects anonymous users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/evals/latest' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('forbids a pupil', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const jar = await loginAs(pupil);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/evals/latest',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('forbids a teacher (admin-only)', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const jar = await loginAs(teacher);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/evals/latest',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders an empty-state card when no reports have been written', async () => {
    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/evals/latest',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('No eval runs yet');
    expect(res.payload).toContain('npm run eval');
  });

  it('renders totals, per-prompt aggregates, and worst offenders when a report exists', async () => {
    const report = buildReport(
      [greenAggregate(), redAggregate()],
      [passingResult(), passingResult({ fixtureId: 'open_pass_2' }), failingResult()],
      new Date('2026-04-21T12:00:00Z'),
    );
    await writeReport(outDir, report);

    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/evals/latest',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    // Totals card
    expect(res.payload).toContain('2026-04-21T12:00:00.000Z');
    expect(res.payload).toContain('mark_open_response');
    expect(res.payload).toContain('mark_code_response');
    // Aggregate bands: one green, one red. Both variants must render.
    expect(res.payload).toContain('llm-eval-card--green');
    expect(res.payload).toContain('llm-eval-card--red');
    // Worst offender surfaces its fixture id and reason
    expect(res.payload).toContain('open_fail');
    expect(res.payload).toContain('marker under-awarded');
    // Failures table shows the reason
    expect(res.payload).toContain('outside expected range');
  });

  it('picks the newest report when more than one is on disk', async () => {
    const older = buildReport([], [], new Date('2026-04-20T12:00:00Z'));
    const newer = buildReport(
      [greenAggregate()],
      [passingResult()],
      new Date('2026-04-21T12:00:00Z'),
    );
    await writeReport(outDir, older);
    await writeReport(outDir, newer);

    const admin = await createUser(pool, { role: 'admin' });
    const jar = await loginAs(admin);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/evals/latest',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('2026-04-21T12:00:00.000Z');
    expect(res.payload).not.toContain('2026-04-20T12:00:00.000Z');
  });
});
