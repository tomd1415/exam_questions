import { describe, it, expect, beforeEach } from 'vitest';
import { QuestionRepo } from '../../src/repos/questions.js';
import { CurriculumRepo } from '../../src/repos/curriculum.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const questions = new QuestionRepo(pool);
const curriculum = new CurriculumRepo(pool);

beforeEach(async () => {
  await cleanDb();
});

describe('QuestionRepo.listQuestions', () => {
  it('returns the seeded Phase 0 question with no filters', async () => {
    const all = await questions.listQuestions();
    expect(all.length).toBeGreaterThanOrEqual(1);
    const seed = all.find((q) => q.id === '1');
    expect(seed?.topic_code).toBe('1.1');
    expect(seed?.topic_title).toBe('Systems architecture');
    expect(seed?.command_word_code).toBe('describe');
    expect(seed?.created_by_display_name).toBe('Phase 0 Seed (system)');
  });

  it('filters by topic', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      stem: 'Memory question',
    });

    const inOneOne = await questions.listQuestions({ topic: '1.1' });
    expect(inOneOne.every((q) => q.topic_code === '1.1')).toBe(true);
    const inOneTwo = await questions.listQuestions({ topic: '1.2' });
    expect(inOneTwo.every((q) => q.topic_code === '1.2')).toBe(true);
    expect(inOneTwo.some((q) => q.stem === 'Memory question')).toBe(true);
  });

  it('filters by approval_status', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, { approvalStatus: 'draft' });
    await createQuestion(pool, teacher.id, { approvalStatus: 'pending_review' });

    const drafts = await questions.listQuestions({ approvalStatus: 'draft' });
    expect(drafts.every((q) => q.approval_status === 'draft')).toBe(true);
    expect(drafts.length).toBeGreaterThanOrEqual(1);

    const pending = await questions.listQuestions({ approvalStatus: 'pending_review' });
    expect(pending.every((q) => q.approval_status === 'pending_review')).toBe(true);
    expect(pending.length).toBe(1);
  });

  it('filters by active flag', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, { approvalStatus: 'approved', active: true });

    const inactive = await questions.listQuestions({ active: false });
    expect(inactive.every((q) => q.active === false)).toBe(true);

    const active = await questions.listQuestions({ active: true });
    expect(active.every((q) => q.active === true)).toBe(true);
    // Seed question is active=true and the one we just created is active=true.
    expect(active.length).toBeGreaterThanOrEqual(2);
  });

  it('combines filters with AND semantics', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      subtopicCode: '1.2.1',
      approvalStatus: 'approved',
      active: true,
    });
    const got = await questions.listQuestions({
      topic: '1.2',
      approvalStatus: 'approved',
      active: true,
    });
    expect(got.length).toBe(1);
    expect(got[0]?.topic_code).toBe('1.2');
    expect(got[0]?.approval_status).toBe('approved');
    expect(got[0]?.active).toBe(true);
  });
});

describe('QuestionRepo.getQuestionWithPartsAndMarkPoints', () => {
  it('returns the seeded question with parts and mark points', async () => {
    const detail = await questions.getQuestionWithPartsAndMarkPoints('1');
    expect(detail).not.toBeNull();
    expect(detail!.question.topic_title).toBe('Systems architecture');
    expect(detail!.question.subtopic_title).toBeTruthy();
    expect(detail!.parts).toHaveLength(1);
    const partId = detail!.parts[0]!.id;
    const mps = detail!.markPointsByPart.get(partId) ?? [];
    expect(mps.length).toBe(2);
    expect(mps.map((m) => m.display_order)).toEqual([1, 2]);
  });

  it('returns null for an unknown id', async () => {
    expect(await questions.getQuestionWithPartsAndMarkPoints('999999')).toBeNull();
  });

  it('returns parts in display_order with their mark points keyed by part id', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const created = await createQuestion(pool, teacher.id, {
      parts: [
        {
          label: '(a)',
          prompt: 'First part.',
          marks: 1,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'Point A1' }, { text: 'Point A2' }],
        },
        {
          label: '(b)',
          prompt: 'Second part.',
          marks: 3,
          expectedResponseType: 'short_text',
          markPoints: [{ text: 'Point B1' }],
        },
      ],
    });

    const detail = await questions.getQuestionWithPartsAndMarkPoints(created.id);
    expect(detail).not.toBeNull();
    expect(detail!.parts.map((p) => p.part_label)).toEqual(['(a)', '(b)']);

    const aId = detail!.parts[0]!.id;
    const bId = detail!.parts[1]!.id;
    expect(detail!.markPointsByPart.get(aId)?.map((m) => m.text)).toEqual(['Point A1', 'Point A2']);
    expect(detail!.markPointsByPart.get(bId)?.map((m) => m.text)).toEqual(['Point B1']);
  });
});

describe('CurriculumRepo.listTopics', () => {
  it('returns topics in (component, display_order) order', async () => {
    const topics = await curriculum.listTopics();
    expect(topics.length).toBeGreaterThanOrEqual(2);
    expect(topics[0]?.code).toBe('1.1');
    // Component 1 topics come before component 2 topics.
    const firstTwo = topics.find((t) => t.component_code === 'J277/02');
    const lastOne = topics.filter((t) => t.component_code === 'J277/01').slice(-1)[0];
    expect(topics.indexOf(lastOne!)).toBeLessThan(topics.indexOf(firstTwo!));
  });
});
