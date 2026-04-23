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
import { PromptVersionService } from '../../src/services/prompts.js';
import { FAMILY_B_OUTPUT_SCHEMA } from '../../src/services/prompts_bootstrap.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createQuestion, createUser } from '../helpers/fixtures.js';

// Submit-path integration for Family B. Asserts the full loop:
// pupil saves a medium_text answer, submitAttempt runs, dispatch
// hands the part to the LLM marker, a fake fetch returns a valid
// Family B JSON payload, AttemptService persists an awarded_marks
// row with marker='llm', LlmClient writes a matching llm_calls row
// with status='ok', and AuditService records a marking.llm.ok event.

const pool = getSharedPool();
const attemptRepo = new AttemptRepo(pool);
const classRepo = new ClassRepo(pool);
const auditRepo = new AuditRepo(pool);
const auditService = new AuditService(auditRepo);
const llmCallRepo = new LlmCallRepo(pool);
const promptRepo = new PromptVersionRepo(pool);

async function seedActivePrompt(
  name: 'mark_open_response' | 'mark_code_response' = 'mark_open_response',
): Promise<PromptVersionRow> {
  return promptRepo.upsert({
    name,
    version: `v0.1.0-test-${randomBytes(3).toString('hex')}`,
    modelId: 'gpt-5-mini',
    systemPrompt: `You are a test ${name} marker.`,
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
  // Fill in the nullable fields the strict Structured Outputs schema
  // requires (see FAMILY_B_OUTPUT_SCHEMA comment). Keeps test
  // fixtures focused on the fields under test.
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
      usage: { input_tokens: 200, output_tokens: 80 },
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
  await pool.query(
    `DELETE FROM prompt_versions WHERE name IN ('mark_open_response', 'mark_code_response')`,
  );
});

async function setup(): Promise<{
  teacher: { id: string };
  pupil: { id: string };
}> {
  const teacher = await createUser(pool, { role: 'teacher' });
  const pupil = await createUser(pool, { role: 'pupil' });
  const cls = await classRepo.createClass({
    name: 'LLM submit test',
    teacherId: teacher.id,
    academicYear: '2025/26',
  });
  await classRepo.addEnrolment(cls.id, pupil.id);
  await classRepo.assignTopic(cls.id, '1.2', teacher.id);
  return { teacher, pupil };
}

describe('AttemptService.submitAttempt — LLM path for medium_text', () => {
  it('writes marker=llm, a matching llm_calls row, and a marking.llm.ok audit event', async () => {
    const { teacher, pupil } = await setup();
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
    const promptVersion = await seedActivePrompt();

    // Closure-held payload so the fetch stub can cite the real
    // mark_point_ids once they are known after startTopicSet.
    let payload: FamilyBPayload | null = null;
    const fetchImpl: typeof fetch = (_input, _init) => {
      if (!payload) return Promise.reject(new Error('payload not prepared'));
      return Promise.resolve(okResponse(payload));
    };
    const service = await buildLlmAttemptService(fetchImpl);

    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    const part = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!;
    const mps = bundle!.markPointsByPart.get(part.question_part_id)!;
    expect(mps).toHaveLength(2);

    await service.saveAnswer(actor, attemptId, [
      {
        attemptPartId: part.id,
        rawAnswer:
          'The CPU runs the program instructions one after another. The GPU is specialised for drawing pixels to the screen.',
      },
    ]);

    payload = {
      marks_awarded: 3,
      mark_points_hit: [
        { mark_point_id: mps[0]!.id, evidence_quote: 'runs the program instructions' },
        { mark_point_id: mps[1]!.id, evidence_quote: 'drawing pixels to the screen' },
      ],
      mark_points_missed: [],
      contradiction_detected: false,
      over_answer_detected: false,
      confidence: 0.87,
      feedback_for_pupil: {
        what_went_well: 'Both roles identified clearly with specific language.',
        how_to_gain_more: 'Add one sentence on parallelism vs sequential execution.',
        next_focus: 'Link the CPU/GPU split to why GPUs suit graphics workloads.',
      },
      feedback_for_teacher: {
        summary: 'Solid answer; 3/4 awarded for coverage without depth on parallelism.',
      },
      refusal: false,
    };

    const res = await service.submitAttempt(actor, attemptId);
    expect(res.markedParts).toBe(1);
    expect(res.pendingParts).toBe(0);

    const { rows: awardedRows } = await pool.query<{
      marker: string;
      marks_awarded: number;
      marks_total: number;
      confidence: string | null;
      prompt_version: string | null;
      model_id: string | null;
      evidence_quotes: string[] | null;
      moderation_status: string;
    }>(
      `SELECT marker, marks_awarded, marks_total, confidence::text, prompt_version,
              model_id, evidence_quotes, moderation_status
         FROM awarded_marks
        WHERE attempt_part_id = $1::bigint`,
      [part.id],
    );
    expect(awardedRows).toHaveLength(1);
    const awarded = awardedRows[0]!;
    expect(awarded.marker).toBe('llm');
    expect(awarded.marks_awarded).toBe(3);
    expect(awarded.marks_total).toBe(4);
    expect(awarded.confidence).not.toBeNull();
    expect(Number(awarded.confidence)).toBeCloseTo(0.87, 2);
    expect(awarded.prompt_version).toBe(`${promptVersion.name}@${promptVersion.version}`);
    expect(awarded.model_id).toBe(promptVersion.model_id);
    expect(awarded.evidence_quotes).toEqual([
      'runs the program instructions',
      'drawing pixels to the screen',
    ]);
    expect(awarded.moderation_status).toBe('not_required');

    const { rows: callRows } = await pool.query<{
      status: string;
      attempt_part_id: string;
      prompt_version_id: string;
      model_id: string;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT status, attempt_part_id::text, prompt_version_id::text, model_id,
              input_tokens, output_tokens
         FROM llm_calls
        WHERE attempt_part_id = $1::bigint`,
      [part.id],
    );
    expect(callRows).toHaveLength(1);
    expect(callRows[0]!.status).toBe('ok');
    expect(callRows[0]!.prompt_version_id).toBe(promptVersion.id);
    expect(callRows[0]!.model_id).toBe(promptVersion.model_id);
    expect(callRows[0]!.input_tokens).toBe(200);
    expect(callRows[0]!.output_tokens).toBe(80);

    const { rows: auditRows } = await pool.query<{
      event_type: string;
      details: Record<string, unknown>;
    }>(
      `SELECT event_type, details
         FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'marking.llm.ok'
        ORDER BY at ASC`,
      [pupil.id],
    );
    expect(auditRows).toHaveLength(1);
    const details = auditRows[0]!.details;
    expect(details['attempt_part_id']).toBe(part.id);
    expect(details['prompt_version']).toBe(`${promptVersion.name}@${promptVersion.version}`);
    expect(details['model_id']).toBe(promptVersion.model_id);
  });

  it('leaves the part pending and emits marking.llm.http_error when the API fails', async () => {
    const { teacher, pupil } = await setup();
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      modelAnswer: 'Answer.',
      parts: [
        {
          label: '(a)',
          prompt: 'Explain at length.',
          marks: 4,
          expectedResponseType: 'extended_response',
        },
      ],
    });
    const promptVersion = await seedActivePrompt();

    // One 400 per attempt — 4xx is not retried, so a single call row
    // results and a single audit event is emitted.
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'bad request' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const service = await buildLlmAttemptService(fetchImpl);

    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    const part = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!;
    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: part.id, rawAnswer: 'Long answer.' },
    ]);

    const res = await service.submitAttempt(actor, attemptId);
    expect(res.markedParts).toBe(0);
    expect(res.pendingParts).toBe(1);

    const { rows: awardedRows } = await pool.query(
      `SELECT id FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [part.id],
    );
    expect(awardedRows).toHaveLength(0);

    const { rows: callRows } = await pool.query<{ status: string }>(
      `SELECT status FROM llm_calls WHERE attempt_part_id = $1::bigint`,
      [part.id],
    );
    expect(callRows).toHaveLength(1);
    expect(callRows[0]!.status).toBe('http_error');

    const { rows: auditRows } = await pool.query<{
      event_type: string;
      details: Record<string, unknown>;
    }>(
      `SELECT event_type, details
         FROM audit_events
        WHERE actor_user_id = $1::bigint AND event_type = 'marking.llm.http_error'`,
      [pupil.id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.details['status']).toBe(400);
    expect(auditRows[0]!.details['prompt_version']).toBe(
      `${promptVersion.name}@${promptVersion.version}`,
    );
  });
});

describe('AttemptService.submitAttempt — LLM path for code/algorithm (Chunk 3f)', () => {
  for (const responseType of ['code', 'algorithm'] as const) {
    it(`routes ${responseType} parts to mark_code_response and writes marker=llm`, async () => {
      const { teacher, pupil } = await setup();
      await createQuestion(pool, teacher.id, {
        topicCode: '1.2',
        active: true,
        approvalStatus: 'approved',
        modelAnswer: 'A short loop counting from 1 to 5.',
        parts: [
          {
            label: '(a)',
            prompt: 'Write pseudocode that prints the numbers 1 to 5.',
            marks: 3,
            expectedResponseType: responseType,
            markPoints: [
              { text: 'Uses a for loop with correct bounds', marks: 2 },
              { text: 'Prints inside the loop body', marks: 1 },
            ],
          },
        ],
      });
      const codePrompt = await seedActivePrompt('mark_code_response');

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
          rawAnswer: 'for i = 1 to 5\n  print(i)\nnext i',
        },
      ]);

      payload = {
        marks_awarded: 3,
        mark_points_hit: [
          { mark_point_id: mps[0]!.id, evidence_quote: 'for i = 1 to 5' },
          { mark_point_id: mps[1]!.id, evidence_quote: 'print(i)' },
        ],
        mark_points_missed: [],
        contradiction_detected: false,
        over_answer_detected: false,
        confidence: 0.91,
        feedback_for_pupil: {
          what_went_well: 'Loop bounds and print line are both correct.',
          how_to_gain_more: 'Add a comment explaining the step-by-step behaviour.',
          next_focus: 'Try a while-loop version to show the alternative.',
        },
        feedback_for_teacher: {
          summary: 'Clean pseudocode, correct bounds, correct body.',
        },
        refusal: false,
      };

      const res = await service.submitAttempt(actor, attemptId);
      expect(res.markedParts).toBe(1);
      expect(res.pendingParts).toBe(0);

      const { rows: awardedRows } = await pool.query<{
        marker: string;
        prompt_version: string | null;
        model_id: string | null;
      }>(
        `SELECT marker, prompt_version, model_id
           FROM awarded_marks
          WHERE attempt_part_id = $1::bigint`,
        [part.id],
      );
      expect(awardedRows).toHaveLength(1);
      expect(awardedRows[0]!.marker).toBe('llm');
      expect(awardedRows[0]!.prompt_version).toBe(`${codePrompt.name}@${codePrompt.version}`);
      expect(awardedRows[0]!.model_id).toBe(codePrompt.model_id);

      const { rows: callRows } = await pool.query<{
        status: string;
        prompt_version_id: string;
      }>(
        `SELECT status, prompt_version_id::text
           FROM llm_calls
          WHERE attempt_part_id = $1::bigint`,
        [part.id],
      );
      expect(callRows).toHaveLength(1);
      expect(callRows[0]!.status).toBe('ok');
      expect(callRows[0]!.prompt_version_id).toBe(codePrompt.id);
    });
  }

  it('holds a code part as pending when only mark_open_response is active', async () => {
    const { teacher, pupil } = await setup();
    await createQuestion(pool, teacher.id, {
      topicCode: '1.2',
      active: true,
      approvalStatus: 'approved',
      modelAnswer: 'A short loop.',
      parts: [
        {
          label: '(a)',
          prompt: 'Write pseudocode that counts to 5.',
          marks: 3,
          expectedResponseType: 'code',
        },
      ],
    });
    await seedActivePrompt('mark_open_response');

    const fetchImpl: typeof fetch = () => {
      throw new Error('fetch should not be called when the mapped prompt is missing');
    };
    const service = await buildLlmAttemptService(fetchImpl);

    const actor = { id: pupil.id, role: 'pupil' as const };
    const { attemptId } = await service.startTopicSet(actor, '1.2');
    const bundle = await attemptRepo.loadAttemptBundle(attemptId);
    const part = bundle!.partsByQuestion.get(bundle!.questions[0]!.id)![0]!;
    await service.saveAnswer(actor, attemptId, [
      { attemptPartId: part.id, rawAnswer: 'for i = 1 to 5\n  print(i)' },
    ]);

    const res = await service.submitAttempt(actor, attemptId);
    expect(res.markedParts).toBe(0);
    expect(res.pendingParts).toBe(1);

    const { rows: awardedRows } = await pool.query(
      `SELECT id FROM awarded_marks WHERE attempt_part_id = $1::bigint`,
      [part.id],
    );
    expect(awardedRows).toHaveLength(0);

    const { rows: callRows } = await pool.query(
      `SELECT id FROM llm_calls WHERE attempt_part_id = $1::bigint`,
      [part.id],
    );
    expect(callRows).toHaveLength(0);
  });
});
