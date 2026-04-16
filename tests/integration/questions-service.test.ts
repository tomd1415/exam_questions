import { describe, it, expect, beforeEach } from 'vitest';
import { QuestionRepo } from '../../src/repos/questions.js';
import { CurriculumRepo } from '../../src/repos/curriculum.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { AuditService } from '../../src/services/audit.js';
import {
  ApprovalTransitionError,
  QuestionAccessError,
  QuestionInvariantError,
  QuestionService,
} from '../../src/services/questions.js';
import type { QuestionDraft } from '../../src/lib/question-invariants.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const questionRepo = new QuestionRepo(pool);
const curriculumRepo = new CurriculumRepo(pool);
const auditRepo = new AuditRepo(pool);
const auditService = new AuditService(auditRepo);
const service = new QuestionService(questionRepo, curriculumRepo, auditService);

beforeEach(async () => {
  await cleanDb();
});

function sampleDraft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
    command_word_code: 'describe',
    archetype_code: 'explain',
    stem: 'Describe the purpose of the ALU.',
    expected_response_type: 'short_text',
    model_answer: 'The ALU performs arithmetic and logic.',
    feedback_template: null,
    difficulty_band: 3,
    difficulty_step: 1,
    source_type: 'teacher',
    review_notes: null,
    parts: [
      {
        part_label: '(a)',
        prompt: 'State one arithmetic operation.',
        marks: 1,
        expected_response_type: 'short_text',
        mark_points: [
          { text: 'addition', accepted_alternatives: ['+'], marks: 1, is_required: false },
        ],
        misconceptions: [],
      },
    ],
    ...overrides,
  };
}

async function countAuditEvents(eventType: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events WHERE event_type = $1`,
    [eventType],
  );
  return Number.parseInt(rows[0]!.n, 10);
}

describe('QuestionService.createDraft', () => {
  it('inserts the question, its parts and mark points in one transaction', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const before = await countAuditEvents('question.created');
    const id = await service.createDraft(
      { id: teacher.id, role: 'teacher' },
      sampleDraft({
        parts: [
          {
            part_label: '(a)',
            prompt: 'First.',
            marks: 2,
            expected_response_type: 'short_text',
            mark_points: [
              { text: 'Point A1', accepted_alternatives: [], marks: 1, is_required: false },
              { text: 'Point A2', accepted_alternatives: [], marks: 1, is_required: true },
            ],
            misconceptions: [],
          },
          {
            part_label: '(b)',
            prompt: 'Second.',
            marks: 1,
            expected_response_type: 'short_text',
            mark_points: [
              { text: 'Point B1', accepted_alternatives: [], marks: 1, is_required: false },
            ],
            misconceptions: [{ label: 'Mixed up X and Y', description: 'Swap symptom.' }],
          },
        ],
      }),
    );
    const detail = await questionRepo.getQuestionWithPartsAndMarkPoints(id);
    expect(detail).not.toBeNull();
    expect(detail!.question.marks_total).toBe(3);
    expect(detail!.question.approval_status).toBe('draft');
    expect(detail!.question.active).toBe(false);
    expect(detail!.parts.map((p) => p.part_label)).toEqual(['(a)', '(b)']);

    const aId = detail!.parts[0]!.id;
    const bId = detail!.parts[1]!.id;
    expect(detail!.markPointsByPart.get(aId)?.map((m) => m.text)).toEqual(['Point A1', 'Point A2']);
    expect(detail!.markPointsByPart.get(aId)?.[1]?.is_required).toBe(true);
    expect(detail!.misconceptionsByPart.get(bId)?.[0]?.label).toBe('Mixed up X and Y');

    expect(await countAuditEvents('question.created')).toBe(before + 1);
  });

  it('raises QuestionInvariantError for an invalid draft and writes nothing', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const before = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM questions`);
    const bad = sampleDraft();
    bad.parts[0]!.mark_points = [];
    await expect(service.createDraft({ id: teacher.id, role: 'teacher' }, bad)).rejects.toThrow(
      QuestionInvariantError,
    );
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM questions`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('raises QuestionAccessError when a pupil tries to author', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await expect(
      service.createDraft({ id: pupil.id, role: 'pupil' }, sampleDraft()),
    ).rejects.toThrow(QuestionAccessError);
  });
});

describe('QuestionService.updateDraft', () => {
  it('replaces parts and mark points atomically and audits', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const id = await service.createDraft(actor, sampleDraft());

    const updated = sampleDraft({
      stem: 'Revised stem.',
      parts: [
        {
          part_label: '(a)',
          prompt: 'Revised prompt.',
          marks: 2,
          expected_response_type: 'short_text',
          mark_points: [
            { text: 'New MP 1', accepted_alternatives: [], marks: 1, is_required: false },
            { text: 'New MP 2', accepted_alternatives: [], marks: 1, is_required: false },
          ],
          misconceptions: [],
        },
      ],
    });

    const before = await countAuditEvents('question.updated');
    await service.updateDraft(actor, id, updated);

    const detail = await questionRepo.getQuestionWithPartsAndMarkPoints(id);
    expect(detail!.question.stem).toBe('Revised stem.');
    expect(detail!.question.marks_total).toBe(2);
    expect(detail!.parts).toHaveLength(1);
    const aId = detail!.parts[0]!.id;
    expect(detail!.markPointsByPart.get(aId)?.map((m) => m.text)).toEqual(['New MP 1', 'New MP 2']);
    expect(await countAuditEvents('question.updated')).toBe(before + 1);
  });

  it('refuses to update another teacher’s draft', async () => {
    const alice = await createUser(pool, { role: 'teacher' });
    const bob = await createUser(pool, { role: 'teacher' });
    const id = await service.createDraft({ id: alice.id, role: 'teacher' }, sampleDraft());
    await expect(
      service.updateDraft({ id: bob.id, role: 'teacher' }, id, sampleDraft()),
    ).rejects.toMatchObject({ reason: 'not_owner' });
  });

  it('allows an admin to edit any teacher’s draft', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const admin = await createUser(pool, { role: 'admin' });
    const id = await service.createDraft({ id: teacher.id, role: 'teacher' }, sampleDraft());
    await service.updateDraft(
      { id: admin.id, role: 'admin' },
      id,
      sampleDraft({ stem: 'Admin edit.' }),
    );
    const detail = await questionRepo.getQuestionWithPartsAndMarkPoints(id);
    expect(detail!.question.stem).toBe('Admin edit.');
  });
});

describe('QuestionService.setApprovalStatus', () => {
  it('moves draft → approved and flips active=true with approved_by + audit', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const id = await service.createDraft(actor, sampleDraft());

    const before = await countAuditEvents('question.approved');
    await service.setApprovalStatus(actor, id, 'approved');
    const detail = await questionRepo.getQuestionWithPartsAndMarkPoints(id);
    expect(detail!.question.approval_status).toBe('approved');
    expect(detail!.question.active).toBe(true);
    expect(detail!.question.approved_by_display_name).toBe(teacher.display_name);
    expect(await countAuditEvents('question.approved')).toBe(before + 1);
  });

  it('moves pending_review → rejected and requires review_notes', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const id = await service.createDraft(actor, sampleDraft());
    await service.setApprovalStatus(actor, id, 'pending_review');

    await expect(service.setApprovalStatus(actor, id, 'rejected', '  ')).rejects.toThrow(
      QuestionInvariantError,
    );

    await service.setApprovalStatus(actor, id, 'rejected', 'Mark scheme incorrect.');
    const detail = await questionRepo.getQuestionWithPartsAndMarkPoints(id);
    expect(detail!.question.approval_status).toBe('rejected');
    expect(detail!.question.active).toBe(false);
    expect(detail!.question.review_notes).toBe('Mark scheme incorrect.');
  });

  it('rejects disallowed transitions', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const actor = { id: teacher.id, role: 'teacher' as const };
    const id = await service.createDraft(actor, sampleDraft());
    await service.setApprovalStatus(actor, id, 'approved');
    // approved → pending_review is not allowed
    await expect(service.setApprovalStatus(actor, id, 'pending_review')).rejects.toThrow(
      ApprovalTransitionError,
    );
  });

  it('refuses approval on another teacher’s draft', async () => {
    const alice = await createUser(pool, { role: 'teacher' });
    const bob = await createUser(pool, { role: 'teacher' });
    const id = await service.createDraft({ id: alice.id, role: 'teacher' }, sampleDraft());
    await expect(
      service.setApprovalStatus({ id: bob.id, role: 'teacher' }, id, 'approved'),
    ).rejects.toMatchObject({ reason: 'not_owner' });
  });
});
