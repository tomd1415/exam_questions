/**
 * ⚠️  One real OpenAI call, one real awarded-marks row.
 *
 *   npm run seed:ai-feedback-live -- --yes
 *
 * Drives a single open-response part through the production marking
 * stack: LlmOpenResponseMarker → Structured Outputs → safety gate →
 * writeLlmMark. The result lands on a fresh `mixed`-mode attempt for
 * pupil1 so you can sign in and compare the real AI feedback against
 * the synthetic rows produced by seed-ai-feedback-demo.ts.
 *
 * Safety / cost envelope:
 *   - Requires `--yes`. Without it, the script prints what it would
 *     have done and exits 0.
 *   - Requires LLM_ENABLED=true AND a non-empty OPENAI_API_KEY.
 *   - Exactly one LLM call per invocation. The llm_calls table will
 *     record the cost; expected ≤ 1p per run at gpt-5-mini prices.
 *   - The pupil_answer is prefixed with "[LIVE AI DEMO {timestamp}]"
 *     so every row produced by this script is unambiguously
 *     identifiable in the DB.
 *
 * Idempotent: re-running tears down any prior live-demo attempt for
 * the same pupil before creating a new one.
 */
import { parseArgs } from 'node:util';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import { ContentGuardRepo } from '../../src/repos/content_guards.js';
import { LlmCallRepo } from '../../src/repos/llm_calls.js';
import { PromptVersionRepo } from '../../src/repos/prompts.js';
import { AttemptRepo, type AwardedMarkFeedbackForPupil } from '../../src/repos/attempts.js';
import { ContentGuardService } from '../../src/services/content_guards.js';
import { LlmClient } from '../../src/services/llm/client.js';
import { LlmOpenResponseMarker, type LlmMarkingInput } from '../../src/services/marking/llm.js';
import { evaluateSafetyGate } from '../../src/services/marking/safety-gate.js';
import { PromptVersionService } from '../../src/services/prompts.js';

const PUPIL_USERNAME = 'pupil1';
const CLASS_NAME = 'Phase 1 Lesson Test';
const ACADEMIC_YEAR = '2025-26';
const LIVE_SENTINEL = '[LIVE AI DEMO';

// Curated part chosen for a tight, easy-to-verify answer surface.
// question_parts.id 3 — "Describe what happens during the fetch-execute
// cycle." Three mark points, 2 marks; the LLM only has to name two of
// the three stages correctly. Stable across re-runs because content:seed
// upserts by similarity_hash.
const LIVE_PART_ID = 3;
const LIVE_PUPIL_ANSWER =
  'The CPU fetches the next instruction from main memory using the program counter. ' +
  'The control unit then decodes it, and finally the ALU executes the instruction and the result ' +
  'may be written back to a register before the cycle begins again.';

function banner(): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  ⚠  LIVE OPENAI CALL  ⚠                                                  ║');
  console.log('║                                                                          ║');
  console.log('║  This script is about to make ONE real OpenAI Responses API call.        ║');
  console.log('║  It will cost real pence (expected ≤ 1p at gpt-5-mini rates).            ║');
  console.log('║  The result will be written to the DB as an AI-marked awarded_marks      ║');
  console.log('║  row against pupil1, tagged with [LIVE AI DEMO …] in the pupil answer.  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { yes: { type: 'boolean', default: false } },
  });

  banner();

  if (!config.LLM_ENABLED) {
    console.error('Aborting: LLM_ENABLED is false. Set it to true in .env and retry.');
    process.exitCode = 2;
    return;
  }
  if (!config.OPENAI_API_KEY) {
    console.error('Aborting: OPENAI_API_KEY is not set.');
    process.exitCode = 2;
    return;
  }
  if (!values.yes) {
    console.log('Dry-run: pass --yes to actually make the call.');
    console.log(`Would call with pupil answer:\n  ${LIVE_PUPIL_ANSWER}`);
    return;
  }

  const { rows: userRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM users WHERE username = $1 AND role = 'pupil' AND active = true`,
    [PUPIL_USERNAME],
  );
  const pupilId = userRows[0]?.id;
  if (!pupilId)
    throw new Error(`Pupil '${PUPIL_USERNAME}' not found. Run 'npm run setup:lesson' first.`);

  const { rows: classRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM classes WHERE name = $1 AND academic_year = $2 LIMIT 1`,
    [CLASS_NAME, ACADEMIC_YEAR],
  );
  const classId = classRows[0]?.id;
  if (!classId)
    throw new Error(`Class '${CLASS_NAME}' not found. Run 'npm run setup:lesson' first.`);

  // Tear down any prior live-demo attempts for this pupil.
  await pool.query(
    `DELETE FROM attempts
      WHERE user_id = $1::bigint
        AND id IN (
          SELECT aq.attempt_id
            FROM attempt_questions aq
            JOIN attempt_parts ap ON ap.attempt_question_id = aq.id
           WHERE ap.raw_answer LIKE $2
        )`,
    [pupilId, `${LIVE_SENTINEL}%`],
  );

  // Load the curated part and its mark points.
  const { rows: partRows } = await pool.query<{
    question_id: string;
    marks: number;
    expected_response_type: string;
    prompt: string;
    part_label: string;
    stem: string;
    model_answer: string;
  }>(
    `SELECT qp.question_id::text,
            qp.marks,
            qp.expected_response_type,
            qp.prompt,
            qp.part_label,
            q.stem,
            q.model_answer
       FROM question_parts qp
       JOIN questions q ON q.id = qp.question_id
      WHERE qp.id = $1::bigint`,
    [LIVE_PART_ID],
  );
  if (partRows.length === 0) throw new Error(`question_parts.id ${LIVE_PART_ID} not found`);
  const part = partRows[0]!;

  const { rows: markPointRows } = await pool.query<{
    id: string;
    text: string;
    accepted_alternatives: string[] | null;
    marks: number;
    is_required: boolean;
  }>(
    `SELECT id::text, text, accepted_alternatives, marks, is_required
       FROM mark_points WHERE question_part_id = $1::bigint ORDER BY display_order`,
    [LIVE_PART_ID],
  );

  // Create attempt + attach the one part we're marking.
  // submitted_at=now so the pupil review renders the feedback block
  // (see buildPupilFeedbackByPart).
  const attemptId = await pool
    .query<{ id: string }>(
      `INSERT INTO attempts (user_id, class_id, mode, reveal_mode, submitted_at)
       VALUES ($1::bigint, $2::bigint, 'mixed', 'per_question', now())
     RETURNING id::text`,
      [pupilId, classId],
    )
    .then((r) => r.rows[0]!.id);
  const aqId = await pool
    .query<{ id: string }>(
      `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
       VALUES ($1::bigint, $2::bigint, 1)
     RETURNING id::text`,
      [attemptId, part.question_id],
    )
    .then((r) => r.rows[0]!.id);
  const stamp = new Date().toISOString();
  const pupilAnswer = `${LIVE_SENTINEL} ${stamp}] ${LIVE_PUPIL_ANSWER}`;
  const attemptPartId = await pool
    .query<{ id: string }>(
      `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
       VALUES ($1::bigint, $2::bigint, $3)
     RETURNING id::text`,
      [aqId, LIVE_PART_ID, pupilAnswer],
    )
    .then((r) => r.rows[0]!.id);

  // Wire the marking stack.
  const promptService = new PromptVersionService(new PromptVersionRepo(pool));
  await promptService.loadActive();
  const guardService = new ContentGuardService(new ContentGuardRepo(pool));
  await guardService.refresh();
  const llmClient = new LlmClient(new LlmCallRepo(pool), { apiKey: config.OPENAI_API_KEY });
  const marker = new LlmOpenResponseMarker(llmClient, promptService);

  const input: LlmMarkingInput = {
    part: {
      id: attemptPartId,
      marks: part.marks,
      expected_response_type: part.expected_response_type,
      prompt: part.prompt,
      raw_answer: pupilAnswer,
      part_label: part.part_label,
    },
    markPoints: markPointRows.map((mp) => ({
      id: mp.id,
      text: mp.text,
      accepted_alternatives: mp.accepted_alternatives ?? [],
      marks: mp.marks,
      is_required: mp.is_required,
    })),
    questionStem: part.stem,
    modelAnswer: part.model_answer,
  };

  console.log(`Calling OpenAI for attempt_part_id=${attemptPartId} …`);
  const started = Date.now();
  const outcome = await marker.mark(input);
  const elapsed = Date.now() - started;
  console.log(`OpenAI returned in ${elapsed}ms with kind='${outcome.kind}'.`);

  if (outcome.kind !== 'awarded') {
    console.error(
      `Expected outcome.kind='awarded', got '${outcome.kind}'. Nothing written to awarded_marks.`,
    );
    console.error(JSON.stringify(outcome, null, 2));
    process.exitCode = 3;
    return;
  }

  // Production dispatch runs the gate next.
  const gate = evaluateSafetyGate({
    pupilAnswer,
    confidence: outcome.confidence,
    marksAwarded: outcome.marksAwarded,
    marksAwardedRaw: outcome.marksAwardedRaw,
    marksTotal: outcome.marksTotal,
    hitMarkPointCount: outcome.hitMarkPointIds.length,
    evidenceQuotes: outcome.evidenceQuotes,
    safeguardingPatterns: guardService.getPatterns('safeguarding'),
    promptInjectionPatterns: guardService.getPatterns('prompt_injection'),
  });

  const attemptRepo = new AttemptRepo(pool);
  await attemptRepo.writeLlmMark({
    attemptPartId,
    marksAwarded: outcome.marksAwarded,
    marksTotal: outcome.marksTotal,
    markPointsHit: outcome.hitMarkPointIds,
    markPointsMissed: outcome.missedMarkPointIds,
    evidenceQuotes: outcome.evidenceQuotes,
    confidence: outcome.confidence,
    promptVersion: outcome.promptVersion.version,
    modelId: outcome.promptVersion.model_id,
    moderationRequired: gate.flagged,
    moderationStatus: gate.flagged ? 'pending' : 'not_required',
    moderationNotes: gate.flagged ? gate.reasons : null,
    feedbackForPupil: outcome.feedbackForPupil as AwardedMarkFeedbackForPupil,
  });

  // Fetch the cost row the client wrote so we can report it.
  const { rows: llmCallRows } = await pool.query<{
    id: string;
    input_tokens: number;
    output_tokens: number;
    cost_pence: number;
    latency_ms: number;
    status: string;
  }>(
    `SELECT id::text, input_tokens, output_tokens, cost_pence, latency_ms, status
       FROM llm_calls
      WHERE attempt_part_id = $1::bigint
      ORDER BY id DESC
      LIMIT 1`,
    [attemptPartId],
  );
  const llmCall = llmCallRows[0];

  console.log('');
  console.log('=== LIVE AI feedback written ===');
  console.log(`Attempt id:             ${attemptId}`);
  console.log(`attempt_part_id:        ${attemptPartId}`);
  console.log(`marks:                  ${outcome.marksAwarded}/${outcome.marksTotal}`);
  console.log(`confidence:             ${outcome.confidence.toFixed(2)}`);
  console.log(
    `safety gate flagged:    ${gate.flagged ? 'YES → moderation_status=pending' : 'no → moderation_status=not_required'}`,
  );
  if (llmCall) {
    console.log(
      `OpenAI tokens:          ${llmCall.input_tokens} in / ${llmCall.output_tokens} out`,
    );
    console.log(
      `OpenAI cost:            ${(llmCall.cost_pence / 100).toFixed(4)} GBP (${llmCall.cost_pence}p)`,
    );
    console.log(`OpenAI latency:         ${llmCall.latency_ms} ms`);
  }
  console.log('');
  console.log('Three-header pupil feedback returned by the model:');
  console.log(`  what_went_well:   ${outcome.feedbackForPupil.what_went_well}`);
  console.log(`  how_to_gain_more: ${outcome.feedbackForPupil.how_to_gain_more}`);
  console.log(`  next_focus:       ${outcome.feedbackForPupil.next_focus}`);
  console.log('');
  console.log('Sign in as pupil1 / password-001 and open:');
  console.log(`  http://localhost:3030/attempts/${attemptId}`);
  if (gate.flagged) {
    console.log(
      '(Safety gate flagged this row; clear it at /admin/moderation first so the block renders.)',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
