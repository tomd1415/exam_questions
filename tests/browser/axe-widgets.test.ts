/// <reference lib="dom" />
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { buildApp } from '../../src/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';

// One attempt page per new Phase 2.5 widget type is the PHASE2.5_PLAN.md §10
// sign-off requirement. logic_diagram already has its own drawing-specific
// sweep in axe-drawing.test.ts; this file covers the remaining nine types.
// Each widget seeds one approved, active question under topic 1.1; a single
// pupil attempt covers all nine; axe-core scopes its analysis to `.paper-part`
// so failures point at the widget rather than unrelated page chrome.

interface WidgetCase {
  readonly type: string;
  readonly prompt: string;
  readonly partConfig: unknown;
  readonly markPoints: readonly { text: string; marks: number }[];
}

const CASES: readonly WidgetCase[] = [
  {
    type: 'trace_table',
    prompt: 'Complete the trace table.',
    partConfig: {
      columns: [{ name: 'i' }, { name: 'total' }],
      rows: 2,
      prefill: { '0,0': '1' },
      expected: { '0,1': '2', '1,0': '2', '1,1': '6' },
      marking: { mode: 'perCell' },
    },
    markPoints: [
      { text: 'row 0 total = 2', marks: 1 },
      { text: 'row 1 i = 2', marks: 1 },
      { text: 'row 1 total = 6', marks: 1 },
    ],
  },
  {
    type: 'matrix_tick_single',
    prompt: 'Classify each algorithm.',
    partConfig: {
      rows: ['Bubble sort', 'Linear search'],
      columns: ['Sorting', 'Searching'],
      correctByRow: ['Sorting', 'Searching'],
      allOrNothing: false,
    },
    markPoints: [
      { text: 'Bubble sort — Sorting', marks: 1 },
      { text: 'Linear search — Searching', marks: 1 },
    ],
  },
  {
    type: 'matrix_tick_multi',
    prompt: 'Tick every property that applies.',
    partConfig: {
      rows: ['RAM', 'ROM'],
      columns: ['Volatile', 'Read-only', 'Stores BIOS'],
      correctByRow: [['Volatile'], ['Read-only', 'Stores BIOS']],
      partialCredit: true,
    },
    markPoints: [
      { text: 'RAM — Volatile', marks: 1 },
      { text: 'ROM — Read-only', marks: 1 },
      { text: 'ROM — Stores BIOS', marks: 1 },
    ],
  },
  {
    type: 'cloze_free',
    prompt: 'Fill in the gap.',
    partConfig: {
      text: 'Eight bits make a {{u1}}.',
      gaps: [{ id: 'u1', accept: ['byte'] }],
    },
    markPoints: [{ text: 'byte', marks: 1 }],
  },
  {
    type: 'cloze_with_bank',
    prompt: 'Pick the right term from the bank.',
    partConfig: {
      text: 'A {{d1}} forwards within a LAN.',
      gaps: [{ id: 'd1', accept: ['switch'] }],
      bank: ['switch', 'router', 'hub'],
    },
    markPoints: [{ text: 'switch', marks: 1 }],
  },
  {
    type: 'cloze_code',
    prompt: 'Complete the loop.',
    partConfig: {
      text: 'for i = 1 to {{stop}}\n  print({{counter}})\nnext i',
      gaps: [
        { id: 'stop', accept: ['5'] },
        { id: 'counter', accept: ['i'] },
      ],
    },
    markPoints: [
      { text: 'stop = 5', marks: 1 },
      { text: 'counter = i', marks: 1 },
    ],
  },
  {
    type: 'matching',
    prompt: 'Match each protocol to its use.',
    partConfig: {
      left: ['HTTP', 'SMTP', 'FTP'],
      right: ['web pages', 'email', 'file transfer', 'remote shell'],
      correctPairs: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      partialCredit: true,
    },
    markPoints: [
      { text: 'HTTP — web pages', marks: 1 },
      { text: 'SMTP — email', marks: 1 },
      { text: 'FTP — file transfer', marks: 1 },
    ],
  },
  {
    type: 'diagram_labels',
    prompt: 'Label the network devices.',
    partConfig: {
      imageUrl: '/static/curated/network-topology-star.svg',
      imageAlt: 'Star topology with a central switch and four labelled hosts.',
      width: 600,
      height: 360,
      hotspots: [
        { id: 'centre', x: 260, y: 140, width: 100, height: 60, accept: ['switch', 'hub'] },
        { id: 'host-1', x: 40, y: 40, width: 120, height: 40, accept: ['client', 'host'] },
      ],
    },
    markPoints: [
      { text: 'centre = switch', marks: 1 },
      { text: 'host-1 = client', marks: 1 },
    ],
  },
  {
    type: 'flowchart',
    prompt: 'Draw a flowchart for the algorithm.',
    partConfig: { variant: 'image', canvas: { width: 600, height: 500 } },
    markPoints: [{ text: 'Flowchart drawn', marks: 2 }],
  },
];

const SERIOUS_IMPACTS: readonly string[] = ['serious', 'critical'];

let app: FastifyInstance;
let baseUrl: string;
let browser: Browser;
let pupilCtx: BrowserContext;
let attemptId: string;
let questionIdByType: Map<string, string>;

async function loginVia(p: Page, user: CreatedUser): Promise<void> {
  await p.goto(`${baseUrl}/login`);
  await p.fill('input[name="username"]', user.username);
  await p.fill('input[name="password"]', user.password);
  await Promise.all([
    p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/login',
    ),
    p.click('button[type="submit"]'),
  ]);
  await p.waitForLoadState('domcontentloaded');
}

async function axeOnPart(p: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page: p }).include('.paper-part').analyze();
  const bad = results.violations.filter((v) => SERIOUS_IMPACTS.includes(v.impact ?? ''));
  if (bad.length > 0) {
    const detail = bad
      .map(
        (v) =>
          `  • [${v.impact}] ${v.id} — ${v.help}\n    ${v.nodes
            .slice(0, 3)
            .map(
              (n) =>
                `${n.target.join(' ')}\n      ${(n.failureSummary ?? '').split('\n').join(' / ')}`,
            )
            .join('\n    ')}`,
      )
      .join('\n');
    throw new Error(`axe-core found serious/critical violations on ${label}:\n${detail}`);
  }
}

beforeAll(async () => {
  await cleanDb();
  app = await buildApp({ pool: getSharedPool(), logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = typeof address === 'string' ? address : `http://127.0.0.1:${String(address)}`;

  const pool = getSharedPool();
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year, topic_set_size)
     VALUES ('Widget axe class', $1::bigint, '2025/26', 30) RETURNING id::text`,
    [teacher.id],
  );
  const classId = cls.rows[0]!.id;
  await pool.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    pupil.id,
  ]);
  await pool.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, '1.1', $2::bigint)`,
    [classId, teacher.id],
  );

  for (const c of CASES) {
    await createQuestion(pool, teacher.id, {
      topicCode: '1.1',
      subtopicCode: '1.1.1',
      active: true,
      approvalStatus: 'approved',
      expectedResponseType: c.type,
      stem: `Axe sweep for ${c.type}`,
      parts: [
        {
          label: '(a)',
          prompt: c.prompt,
          marks: c.markPoints.reduce((s, mp) => s + mp.marks, 0) || 1,
          expectedResponseType: c.type,
          partConfig: c.partConfig,
          markPoints: [...c.markPoints],
        },
      ],
    });
  }

  browser = await chromium.launch({ headless: true });
  pupilCtx = await browser.newContext();

  const startResult = await app.services.attempts.startTopicSet(
    { id: pupil.id, role: 'pupil' },
    '1.1',
    'per_question',
  );
  attemptId = String(startResult.attemptId);

  // bundle.questions[i].id is attempt_questions.id (aliased "id" in the SELECT),
  // NOT questions.id — that's what `?q=` expects. Resolve the aq_id per widget.
  questionIdByType = new Map<string, string>();
  const mapping = await pool.query<{ aq_id: string; type: string }>(
    `SELECT aq.id::text AS aq_id, q.expected_response_type AS type
       FROM attempt_questions aq
       JOIN questions q ON q.id = aq.question_id
      WHERE aq.attempt_id = $1::bigint`,
    [attemptId],
  );
  for (const row of mapping.rows) questionIdByType.set(row.type, row.aq_id);

  const pPage = await pupilCtx.newPage();
  await loginVia(pPage, pupil);
  await pPage.close();
}, 120_000);

afterAll(async () => {
  await pupilCtx?.close();
  await browser?.close();
  await app?.close();
});

async function checkWidget(type: string, theme: 'light' | 'dark'): Promise<void> {
  const qid = questionIdByType.get(type);
  if (!qid) throw new Error(`no seeded question for widget type ${type}`);
  const p = await pupilCtx.newPage();
  try {
    const resp = await p.goto(`${baseUrl}/attempts/${attemptId}?q=${qid}`);
    if (resp?.status() !== 200) {
      throw new Error(`expected 200, got ${resp?.status() ?? 'no-response'} for ${type}`);
    }
    await p.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    await p.waitForSelector('.paper-part');
    await axeOnPart(p, `${type} widget (${theme})`);
  } finally {
    await p.close();
  }
}

describe('axe-core per-widget sweep (PHASE2.5_PLAN §10)', () => {
  for (const c of CASES) {
    it(`${c.type} attempt page passes in light mode`, async () => {
      await checkWidget(c.type, 'light');
    }, 30_000);
    it(`${c.type} attempt page passes in dark mode`, async () => {
      await checkWidget(c.type, 'dark');
    }, 30_000);
  }
});
