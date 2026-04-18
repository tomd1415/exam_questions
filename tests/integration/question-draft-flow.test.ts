import { describe, it, expect, beforeEach } from 'vitest';
import { QuestionRepo } from '../../src/repos/questions.js';
import { CurriculumRepo } from '../../src/repos/curriculum.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { QuestionDraftRepo } from '../../src/repos/question_drafts.js';
import { AuditService } from '../../src/services/audit.js';
import { QuestionService } from '../../src/services/questions.js';
import {
  DraftAccessError,
  DraftStateError,
  QuestionDraftService,
} from '../../src/services/question_drafts.js';
import type { QuestionDraft } from '../../src/lib/question-invariants.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const questionRepo = new QuestionRepo(pool);
const draftRepo = new QuestionDraftRepo(pool);
const curriculumRepo = new CurriculumRepo(pool);
const auditRepo = new AuditRepo(pool);
const auditService = new AuditService(auditRepo);
const questionService = new QuestionService(questionRepo, curriculumRepo, auditService);
const service = new QuestionDraftService(draftRepo, questionService, auditService);

beforeEach(async () => {
  await cleanDb();
});

// The full nine-step happy path. Each step's patch is roughly what the
// matching wizard form would POST. We deliberately split fields across the
// "right" steps so the test breaks if the service silently drops one.
function happyPathSteps(): { step: number; patch: Partial<QuestionDraft> }[] {
  return [
    {
      step: 1,
      patch: { component_code: 'J277/01', topic_code: '1.1', subtopic_code: '1.1.1' },
    },
    {
      step: 2,
      patch: { command_word_code: 'describe', archetype_code: 'explain' },
    },
    {
      step: 3,
      patch: { expected_response_type: 'short_text' },
    },
    {
      step: 4,
      patch: {
        parts: [
          {
            part_label: '(a)',
            prompt: 'State one arithmetic operation the ALU performs.',
            marks: 1,
            expected_response_type: 'short_text',
            mark_points: [],
            misconceptions: [],
          },
        ],
      },
    },
    {
      step: 5,
      patch: { stem: 'Describe the purpose of the ALU.' },
    },
    {
      step: 6,
      patch: {
        model_answer: 'The ALU performs arithmetic and logic operations.',
        parts: [
          {
            part_label: '(a)',
            prompt: 'State one arithmetic operation the ALU performs.',
            marks: 1,
            expected_response_type: 'short_text',
            mark_points: [
              { text: 'addition', accepted_alternatives: ['+'], marks: 1, is_required: false },
            ],
            misconceptions: [],
          },
        ],
      },
    },
    {
      step: 7,
      patch: {
        parts: [
          {
            part_label: '(a)',
            prompt: 'State one arithmetic operation the ALU performs.',
            marks: 1,
            expected_response_type: 'short_text',
            mark_points: [
              { text: 'addition', accepted_alternatives: ['+'], marks: 1, is_required: false },
            ],
            misconceptions: [
              {
                label: 'Confuses ALU with CU',
                description: 'Pupil names a control-unit task instead of arithmetic/logic.',
              },
            ],
          },
        ],
      },
    },
    {
      step: 8,
      patch: { difficulty_band: 3, difficulty_step: 1, source_type: 'teacher' },
    },
  ];
}

async function countAuditEvents(eventType: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events WHERE event_type = $1`,
    [eventType],
  );
  return Number.parseInt(rows[0]!.n, 10);
}

describe('QuestionDraftService.create', () => {
  it('creates a draft owned by the actor and writes a question.draft.created audit', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const before = await countAuditEvents('question.draft.created');
    const id = await service.create({ id: teacher.id, role: 'teacher' });
    const row = await draftRepo.findById(id);
    expect(row).not.toBeNull();
    expect(row!.author_user_id).toBe(teacher.id);
    expect(row!.current_step).toBe(1);
    expect(row!.payload).toEqual({});
    expect(row!.published_question_id).toBeNull();
    expect(await countAuditEvents('question.draft.created')).toBe(before + 1);
  });

  it('refuses pupils', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await expect(service.create({ id: pupil.id, role: 'pupil' })).rejects.toMatchObject({
      reason: 'not_teacher',
    });
  });
});

describe('QuestionDraftService.advance and publish', () => {
  it('walks 1→9, publishes, and writes the same rows the seeder/admin form produces', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const draftId = await service.create(actor);

    for (const { step, patch } of happyPathSteps()) {
      const after = await service.advance(actor, draftId, step, patch);
      // current_step is monotonic and points at the next *unanswered* step
      expect(after.current_step).toBe(Math.min(9, step + 1));
    }

    const beforeAdvanced = await countAuditEvents('question.draft.advanced');
    expect(beforeAdvanced).toBe(8);

    const beforePublished = await countAuditEvents('question.draft.published');
    const { questionId } = await service.publish(actor, draftId);
    expect(questionId).toMatch(/^\d+$/);
    expect(await countAuditEvents('question.draft.published')).toBe(beforePublished + 1);

    const detail = await questionRepo.getQuestionWithPartsAndMarkPoints(questionId);
    expect(detail).not.toBeNull();
    expect(detail!.question.stem).toBe('Describe the purpose of the ALU.');
    expect(detail!.question.topic_code).toBe('1.1');
    expect(detail!.question.command_word_code).toBe('describe');
    expect(detail!.question.marks_total).toBe(1);
    expect(detail!.question.approval_status).toBe('draft');
    expect(detail!.question.active).toBe(false);
    expect(detail!.parts).toHaveLength(1);
    const partA = detail!.parts[0]!;
    expect(partA.part_label).toBe('(a)');
    expect(detail!.markPointsByPart.get(partA.id)?.[0]?.text).toBe('addition');
    expect(detail!.misconceptionsByPart.get(partA.id)?.[0]?.label).toBe('Confuses ALU with CU');

    const after = await draftRepo.findById(draftId);
    expect(after!.published_question_id).toBe(questionId);
  });

  it('locks a published draft from further advance', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const draftId = await service.create(actor);
    for (const { step, patch } of happyPathSteps()) {
      await service.advance(actor, draftId, step, patch);
    }
    await service.publish(actor, draftId);

    await expect(
      service.advance(actor, draftId, 5, { stem: 'Trying to edit after publish.' }),
    ).rejects.toMatchObject({ reason: 'already_published' });
    await expect(service.publish(actor, draftId)).rejects.toMatchObject({
      reason: 'already_published',
    });
  });

  it('refuses to publish a draft that has not reached step 9', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const draftId = await service.create(actor);
    for (const { step, patch } of happyPathSteps().slice(0, 4)) {
      await service.advance(actor, draftId, step, patch);
    }
    await expect(service.publish(actor, draftId)).rejects.toMatchObject({
      reason: 'incomplete_for_publish',
    });
  });

  it('hides one author’s drafts from another teacher and refuses cross-author advance', async () => {
    const alice = await createUser(pool, { role: 'teacher' });
    const bob = await createUser(pool, { role: 'teacher' });
    const draftId = await service.create({ id: alice.id, role: 'teacher' });

    const bobsList = await service.listForActor({ id: bob.id, role: 'teacher' });
    expect(bobsList.find((d) => d.id === draftId)).toBeUndefined();

    await expect(
      service.advance({ id: bob.id, role: 'teacher' }, draftId, 1, { topic_code: '1.1' }),
    ).rejects.toBeInstanceOf(DraftAccessError);
    await expect(
      service.findForActor({ id: bob.id, role: 'teacher' }, draftId),
    ).rejects.toMatchObject({ reason: 'not_owner' });
  });

  it('lets an admin read another teacher’s draft', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const admin = await createUser(pool, { role: 'admin' });
    const draftId = await service.create({ id: teacher.id, role: 'teacher' });
    const row = await service.findForActor({ id: admin.id, role: 'admin' }, draftId);
    expect(row.id).toBe(draftId);
  });

  it('rejects step numbers outside 1–9', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const draftId = await service.create(actor);
    await expect(service.advance(actor, draftId, 0, {})).rejects.toBeInstanceOf(DraftStateError);
    await expect(service.advance(actor, draftId, 10, {})).rejects.toBeInstanceOf(DraftStateError);
  });

  it('listForActor returns drafts most-recently-updated first', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const first = await service.create(actor);
    // ensure a measurable updated_at gap
    await new Promise((r) => setTimeout(r, 10));
    const second = await service.create(actor);
    await new Promise((r) => setTimeout(r, 10));
    await service.advance(actor, first, 1, { topic_code: '1.1' });

    const list = await service.listForActor(actor);
    expect(list.map((d) => d.id)).toEqual([first, second]);
  });
});
