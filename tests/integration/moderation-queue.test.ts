import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { ClassRepo } from '../../src/repos/classes.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { LlmCallRepo } from '../../src/repos/llm_calls.js';
import { PromptVersionRepo, type PromptVersionRow } from '../../src/repos/prompts.js';
import { AuditService } from '../../src/services/audit.js';
import { AttemptService } from '../../src/services/attempts.js';
import { LlmClient } from '../../src/services/llm/client.js';
import { LlmOpenResponseMarker } from '../../src/services/marking/llm.js';
import { MarkingDispatcher } from '../../src/services/marking/dispatch.js';
import { ModerationService, ModerationError } from '../../src/services/marking/moderation.js';
import { PromptVersionService } from '../../src/services/prompts.js';
import { FAMILY_B_OUTPUT_SCHEMA } from '../../src/services/prompts_bootstrap.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

// End-to-end check for chunk 3d. Submit path hits the LLM marker
// with a low-confidence payload, the safety gate flips the row to
// moderation_status='pending' with moderation_notes populated, and
// the admin-facing ModerationService can list, accept, and override.

const pool = getSharedPool();
const attemptRepo = new AttemptRepo(pool);
const classRepo = new ClassRepo(pool);
const auditRepo = new AuditRepo(pool);
const auditService = new AuditService(auditRepo);
const llmCallRepo = new LlmCallRepo(pool);
const promptRepo = new PromptVersionRepo(pool);
const moderation = new ModerationService(attemptRepo, auditService);

async function seedActivePrompt(): Promise<PromptVersionRow> {
  return promptRepo.upsert({
    name: 'mark_open_response',
    version: `v0.1.0-test-${randomBytes(3).toString('hex')}`,
    modelId: 'gpt-5-mini',
    systemPrompt: 'You are a test open-response marker.',
    outputSchema: FAMILY_B_OUTPUT_SCHEMA,
    status: 'active',
  });
}

interface FamilyBPayload {
  marks_awarded: number;
  mark_points_hit: { mark_point_id: string; evidence_quote: string }[];
  mark_points_missed: string[];
  contradiction_detected: boolean;
  over_answer_detected: boolean;
  confidence: number;
  feedback_for_pupil: {
    what_went_well: string;
    how_to_gain_more: string;
    next_focus: string;
  };
  feedback_for_teacher: { summary: string };
  refusal: boolean;
}

function okResponse(payload: FamilyBPayload): Response {
  // FAMILY_B_OUTPUT_SCHEMA requires every property be in `required`
  // (OpenAI strict mode). Test fixtures are written against the
  // "happy case" payload shape; fill in the nullable fields here so
  // each test doesn't have to repeat them.
  const wire = {
    ...payload,
    notes: null,
    feedback_for_teacher: {
      suggested_misconception_label: null,
      suggested_next_question_type: null,
      ...payload.feedback_for_teacher,
    },
  };
  return new Response(
    JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(wire) }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function buildLlmAttemptService(fetchImpl: typeof fetch): Promise<AttemptService> {
  const prompts = new PromptVersionService(promptRepo);
  await prompts.loadActive();
  const client = new LlmClient(llmCallRepo, {
    apiKey: 'test-key',
    endpoint: 'https://api.test.invalid/v1/responses',
    fetchImpl,
    timeoutMs: 500,
  });
  const marker = new LlmOpenResponseMarker(client, prompts);
  const dispatcher = new MarkingDispatcher({ llmEnabled: true, llmMarker: marker });
  return new AttemptService(attemptRepo, classRepo, auditService, undefined, dispatcher);
}

beforeEach(async () => {
  await cleanDb();
  await pool.query(`DELETE FROM llm_calls`);
  await pool.query(`DELETE FROM prompt_versions WHERE name = 'mark_open_response'`);
});

async function submitLowConfidenceAnswer(): Promise<{
  teacher: { id: string };
  pupil: { id: string };
  admin: { id: string };
  attemptId: string;
  awardedMarkId: string;
  partMarks: number;
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const admin = await createUser(pool, { role: 'admin' });
  const cls = await classRepo.createClass({
    name: 'Moderation test',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, '1.2', teacher.id);
  await createQuestion(pool, teacher.id, {
    topicCode: '1.2',
    active: true,
    approvalStatus: 'approved',
    modelAnswer: 'The CPU executes instructions; the GPU renders pixels.',
    parts: [
      {
        label: '(a)',
        prompt: 'Explain the difference between the CPU and the GPU.',
        marks: 4,
        expectedResponseType: 'medium_text',
        markPoints: [
          { text: 'CPU executes instructions', marks: 2 },
          { text: 'GPU renders pixels', marks: 2 },
        ],
      },
    ],
  });
  await seedActivePrompt();

  let payload: FamilyBPayload | null = null;
  const fetchImpl: typeof fetch = () => {
    if (!payload) return Promise.reject(new Error('payload not prepared'));
    return Promise.resolve(okResponse(payload));
  };
  const service = await buildLlmAttemptService(fetchImpl);

  const actor = { id: pupil.id, role: 'pupil' as const };
  const { attemptId } = await service.startTopicSet(actor, '1.2');
  const bundle = await attemptRepo.loadAttemptBundle(attemptId);
  const part = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!;
  const mps = bundle!.markPointsByPart.get(part.question_part_id)!;

  await service.saveAnswer(actor, attemptId, [
    {
      attemptPartId: part.id,
      rawAnswer: 'The CPU runs things and the GPU draws pixels.',
    },
  ]);

  payload = {
    marks_awarded: 2,
    mark_points_hit: [
      { mark_point_id: mps[0]!.id, evidence_quote: 'CPU runs things' },
      { mark_point_id: mps[1]!.id, evidence_quote: 'GPU draws pixels' },
    ],
    mark_points_missed: [],
    contradiction_detected: false,
    over_answer_detected: false,
    confidence: 0.35,
    feedback_for_pupil: {
      what_went_well: 'Both components named clearly.',
      how_to_gain_more: 'Explain why each exists, not just what.',
      next_focus: 'Practise comparing parallelism vs serial execution.',
    },
    feedback_for_teacher: { summary: 'Low-detail answer; marks tentative.' },
    refusal: false,
  };

  await service.submitAttempt(actor, attemptId);

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
    [part.id],
  );
  return {
    teacher,
    pupil,
    admin,
    attemptId,
    awardedMarkId: rows[0]!.id,
    partMarks: part.marks,
  };
}

describe('moderation queue end-to-end', () => {
  it('flags a low-confidence LLM mark as pending moderation with typed notes', async () => {
    const { admin, awardedMarkId } = await submitLowConfidenceAnswer();

    const { rows } = await pool.query<{
      moderation_status: string;
      moderation_required: boolean;
      moderation_notes: unknown;
      confidence: string | null;
    }>(
      `SELECT moderation_status, moderation_required, moderation_notes, confidence::text
         FROM awarded_marks
        WHERE id = $1::bigint`,
      [awardedMarkId],
    );
    expect(rows[0]!.moderation_status).toBe('pending');
    expect(rows[0]!.moderation_required).toBe(true);
    const notes = rows[0]!.moderation_notes;
    expect(Array.isArray(notes)).toBe(true);
    const kinds = (notes as { kind: string }[]).map((n) => n.kind);
    expect(kinds).toContain('low_confidence');

    const queue = await moderation.listQueue({ id: admin.id, role: 'admin' });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.awarded_mark_id).toBe(awardedMarkId);
  });

  it('records a marking.llm.flagged audit event at submit time', async () => {
    const { pupil } = await submitLowConfidenceAnswer();
    const { rows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type LIKE 'marking.llm.%'
        ORDER BY at ASC`,
      [pupil.id],
    );
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('marking.llm.flagged');
  });

  it('accept() transitions pending -> accepted and logs moderation.accepted', async () => {
    const { admin, pupil, awardedMarkId } = await submitLowConfidenceAnswer();
    await moderation.accept({ id: admin.id, role: 'admin' }, awardedMarkId);
    const { rows } = await pool.query<{
      moderation_status: string;
      moderation_reviewed_by: string | null;
    }>(
      `SELECT moderation_status, moderation_reviewed_by::text
         FROM awarded_marks WHERE id = $1::bigint`,
      [awardedMarkId],
    );
    expect(rows[0]!.moderation_status).toBe('accepted');
    expect(rows[0]!.moderation_reviewed_by).toBe(admin.id);

    const { rows: audit } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'moderation.accepted'`,
      [admin.id],
    );
    expect(audit).toHaveLength(1);

    // Subsequent acceptance is a no-op error — the row already closed.
    await expect(
      moderation.accept({ id: admin.id, role: 'admin' }, awardedMarkId),
    ).rejects.toBeInstanceOf(ModerationError);
    expect(pupil.id).toBeTruthy();
  });

  it('override() marks the original overridden and writes a teacher_override row', async () => {
    const { admin, awardedMarkId, partMarks } = await submitLowConfidenceAnswer();
    await moderation.override(
      { id: admin.id, role: 'admin' },
      {
        awardedMarkId,
        marksAwarded: partMarks, // full marks on override
        reason: 'Model was too cautious — answer covers both points.',
      },
    );
    const { rows } = await pool.query<{ id: string; marker: string; moderation_status: string }>(
      `SELECT id::text, marker, moderation_status
         FROM awarded_marks
        ORDER BY created_at ASC`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.marker).toBe('llm');
    expect(rows[0]!.moderation_status).toBe('overridden');
    expect(rows[1]!.marker).toBe('teacher_override');
    expect(rows[1]!.moderation_status).toBe('not_required');

    const { rows: audit } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'moderation.overridden'`,
      [admin.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('blocks non-admin actors from the queue and CRUD', async () => {
    const { teacher, awardedMarkId } = await submitLowConfidenceAnswer();
    const asTeacher = { id: teacher.id, role: 'teacher' as const };
    await expect(moderation.listQueue(asTeacher)).rejects.toMatchObject({ reason: 'not_admin' });
    await expect(moderation.accept(asTeacher, awardedMarkId)).rejects.toMatchObject({
      reason: 'not_admin',
    });
    await expect(
      moderation.override(asTeacher, { awardedMarkId, marksAwarded: 0, reason: 'nope' }),
    ).rejects.toMatchObject({ reason: 'not_admin' });
  });

  it('persists feedback_for_pupil JSONB alongside the LLM awarded mark', async () => {
    const { awardedMarkId } = await submitLowConfidenceAnswer();
    const { rows } = await pool.query<{ feedback_for_pupil: unknown }>(
      `SELECT feedback_for_pupil FROM awarded_marks WHERE id = $1::bigint`,
      [awardedMarkId],
    );
    const f = rows[0]!.feedback_for_pupil as Record<string, unknown> | null;
    expect(f).not.toBeNull();
    expect(f!['what_went_well']).toBe('Both components named clearly.');
    expect(f!['how_to_gain_more']).toBe('Explain why each exists, not just what.');
    expect(f!['next_focus']).toBe('Practise comparing parallelism vs serial execution.');
  });

  it('rejects override with marks outside the part range', async () => {
    const { admin, awardedMarkId, partMarks } = await submitLowConfidenceAnswer();
    await expect(
      moderation.override(
        { id: admin.id, role: 'admin' },
        {
          awardedMarkId,
          marksAwarded: partMarks + 5,
          reason: 'too high',
        },
      ),
    ).rejects.toMatchObject({ reason: 'invalid_marks' });
  });
});
