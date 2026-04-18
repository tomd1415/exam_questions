import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser, type CreatedUser } from '../helpers/fixtures.js';
import { cookieHeader, extractCsrfToken, newJar, updateJar } from '../helpers/cookies.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await app.close();
});

function form(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function pool(): ReturnType<typeof getSharedPool> {
  return getSharedPool();
}

async function loginAs(user: CreatedUser): Promise<ReturnType<typeof newJar>> {
  const jar = newJar();
  const getLogin = await app.inject({ method: 'GET', url: '/login' });
  updateJar(jar, getLogin);
  const token = extractCsrfToken(getLogin.payload);
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

async function seedClassWithTopic(params: {
  teacher: CreatedUser;
  pupil: CreatedUser;
  topicCode: string;
}): Promise<void> {
  const p = pool();
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ('Diagram-labels test', $1::bigint, '2025/26') RETURNING id::text`,
    [params.teacher.id],
  );
  const classId = rows[0]!.id;
  await p.query(`INSERT INTO enrolments (class_id, user_id) VALUES ($1::bigint, $2::bigint)`, [
    classId,
    params.pupil.id,
  ]);
  await p.query(
    `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
     VALUES ($1::bigint, $2, $3::bigint)`,
    [classId, params.topicCode, params.teacher.id],
  );
}

async function startTopicAttempt(
  jar: ReturnType<typeof newJar>,
  topicCode: string,
): Promise<string> {
  const listPage = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: cookieHeader(jar) },
  });
  updateJar(jar, listPage);
  const csrf = extractCsrfToken(listPage.payload);
  const startRes = await app.inject({
    method: 'POST',
    url: `/topics/${topicCode}/start`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    payload: form({ _csrf: csrf }),
  });
  expect(startRes.statusCode).toBe(302);
  updateJar(jar, startRes);
  return startRes.headers.location!;
}

describe('Pupil widget — diagram_labels', () => {
  it('renders hotspot inputs over an image and round-trips per-hotspot answers', async () => {
    const teacher = await createUser(pool(), { role: 'teacher' });
    const pupil = await createUser(pool(), { role: 'pupil' });
    await seedClassWithTopic({ teacher, pupil, topicCode: '1.4' });
    await createQuestion(pool(), teacher.id, {
      componentCode: 'J277/01',
      topicCode: '1.4',
      subtopicCode: '1.4.1',
      active: true,
      approvalStatus: 'approved',
      stem: 'Label the star topology.',
      expectedResponseType: 'diagram_labels',
      parts: [
        {
          label: '(a)',
          prompt: 'Label the central device and the four end devices.',
          marks: 3,
          expectedResponseType: 'diagram_labels',
          partConfig: {
            imageUrl: '/static/curated/network-topology-star.svg',
            imageAlt: 'Star topology with a central device and four hosts',
            width: 600,
            height: 360,
            hotspots: [
              {
                id: 'centre',
                x: 240,
                y: 150,
                width: 120,
                height: 60,
                accept: ['switch', 'hub'],
              },
              {
                id: 'top-left',
                x: 40,
                y: 30,
                width: 120,
                height: 60,
                accept: ['client', 'host'],
              },
              {
                id: 'bottom-right',
                x: 440,
                y: 270,
                width: 120,
                height: 60,
                accept: ['client', 'host'],
              },
            ],
          },
          markPoints: [
            { text: 'Central device labelled as switch (or hub)', marks: 1 },
            { text: 'Top-left device labelled as a client/host', marks: 1 },
            { text: 'Bottom-right device labelled as a client/host', marks: 1 },
          ],
        },
      ],
    });

    const jar = await loginAs(pupil);
    const attemptUrl = await startTopicAttempt(jar, '1.4');

    const editPage = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    updateJar(jar, editPage);
    expect(editPage.statusCode).toBe(200);
    const html = editPage.payload;
    expect(html).toMatch(/class="[^"]*\bwidget--diagram-labels\b/);
    expect(html).toContain('src="/static/curated/network-topology-star.svg"');
    expect(html).toMatch(/data-diagram-hotspot="centre"/);
    expect(html).toMatch(/data-diagram-hotspot="top-left"/);
    expect(html).toMatch(/data-diagram-hotspot="bottom-right"/);

    const partMatch = /name="part_(\d+)__centre"/.exec(html);
    expect(partMatch).not.toBeNull();
    const partId = partMatch![1]!;
    expect(html).toMatch(new RegExp(`name="part_${partId}__top-left"`));
    expect(html).toMatch(new RegExp(`name="part_${partId}__bottom-right"`));

    const csrf = extractCsrfToken(html);
    const payload =
      form({ _csrf: csrf }) +
      `&part_${partId}__centre=Switch` +
      `&part_${partId}__top-left=client` +
      `&part_${partId}__bottom-right=`;
    const saveRes = await app.inject({
      method: 'POST',
      url: `${attemptUrl}/save`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
      },
      payload,
    });
    expect(saveRes.statusCode).toBe(302);
    updateJar(jar, saveRes);

    const { rows } = await pool().query<{ raw_answer: string }>(
      `SELECT raw_answer FROM attempt_parts WHERE id = $1::bigint`,
      [partId],
    );
    const stored = rows[0]?.raw_answer ?? '';
    expect(stored).toContain('centre=Switch');
    expect(stored).toContain('top-left=client');
    expect(stored).not.toMatch(/bottom-right=\S/);

    const reopen = await app.inject({
      method: 'GET',
      url: attemptUrl,
      headers: { cookie: cookieHeader(jar) },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.payload).toMatch(/name="part_\d+__centre"\s+value="Switch"/);
    expect(reopen.payload).toMatch(/name="part_\d+__top-left"\s+value="client"/);
  });
});
