/**
 * Free, synthetic pupil-AI-feedback demo.
 *
 *   npm run seed:ai-feedback-demo
 *
 * Creates (or re-creates) one `mixed`-mode attempt for pupil1 in the
 * "Phase 1 Lesson Test" class and writes two synthetic `awarded_marks`
 * rows so the pupil review page renders the three-header feedback
 * block under both of its states:
 *
 *   Part A — marker='llm', moderation_status='not_required'.
 *     Pupil1 signs in and immediately sees the block.
 *   Part B — marker='llm', moderation_status='pending'.
 *     Pupil1 does NOT see the block; it's suppressed until an admin
 *     clears the row at /admin/moderation.
 *
 * No OpenAI calls. No cost. Idempotent — running again tears down the
 * prior demo attempt and rebuilds it. The pupil answers are prefixed
 * with "[AI FEEDBACK DEMO]" so anyone looking in the DB knows this is
 * synthetic data.
 *
 * Runs alongside — but never overlaps with — the live-call variant in
 * seed-ai-feedback-live.ts: the two use different curated questions
 * and different sentinel prefixes so both demos can exist on the same
 * pupil at the same time.
 */
import { pool } from '../../src/db/pool.js';

const PUPIL_USERNAME = 'pupil1';
const CLASS_NAME = 'Phase 1 Lesson Test';
const ACADEMIC_YEAR = '2025-26';
const DEMO_SENTINEL = '[AI FEEDBACK DEMO]';

// Two curated open-response parts. These IDs are stable because
// npm run content:seed is idempotent and upserts by similarity_hash.
// If the seed changes, re-point these constants rather than computing
// them — the whole point of this script is a deterministic demo.
const PART_ACCEPTED = {
  questionId: 3, // "fetch-execute cycle"
  partId: 3,
  answer:
    'The CPU first fetches an instruction from RAM. Then the control unit decodes the instruction into an opcode and operand. Finally the ALU executes it and the result goes back to a register.',
  marksAwarded: 2,
  marksTotal: 2,
  hitMarkPointIds: [6, 7, 8],
  missedMarkPointIds: [] as number[],
  feedback: {
    what_went_well:
      'You covered all three stages — fetch, decode and execute — and named the parts of the CPU involved.',
    how_to_gain_more:
      'Next time, name the specific registers (program counter, MAR, MDR) used during the fetch stage.',
    next_focus:
      'Try a fetch-execute-cycle diagram question so the register names become second nature.',
  },
};

const PART_PENDING = {
  questionId: 8, // "hex to denary"
  partId: 8,
  answer: "You just divide by 16 and that's the denary number.",
  marksAwarded: 0,
  marksTotal: 3,
  hitMarkPointIds: [] as number[],
  missedMarkPointIds: [21, 22, 23],
  feedback: {
    what_went_well: 'You attempted a method rather than leaving the answer blank.',
    how_to_gain_more:
      'Give a worked example with a specific 2-digit hex value and show each step so the examiner can see your method.',
    next_focus: 'Practise two or three hex-to-denary conversions and write each step out in full.',
  },
  // moderation_notes explains *why* the safety gate would have flagged
  // this — in a real run the gate produces a typed SafetyGateReason[].
  moderationNotes: [
    { kind: 'low_confidence', confidence: 0.42, threshold: 0.6 },
    { kind: 'marks_without_evidence', marksAwarded: 0 },
  ],
};

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query<{ id: string }>(
      `SELECT id::text FROM users WHERE username = $1 AND role = 'pupil' AND active = true`,
      [PUPIL_USERNAME],
    );
    const pupilId = userRows[0]?.id;
    if (!pupilId) {
      throw new Error(`Pupil '${PUPIL_USERNAME}' not found. Run 'npm run setup:lesson' first.`);
    }

    const { rows: classRows } = await client.query<{ id: string }>(
      `SELECT id::text FROM classes WHERE name = $1 AND academic_year = $2 LIMIT 1`,
      [CLASS_NAME, ACADEMIC_YEAR],
    );
    const classId = classRows[0]?.id;
    if (!classId) {
      throw new Error(
        `Class '${CLASS_NAME}' (${ACADEMIC_YEAR}) not found. Run 'npm run setup:lesson' first.`,
      );
    }

    // Tear down any prior demo attempts for this pupil. We identify
    // them by the sentinel prefix on raw_answer so live-call demo
    // attempts are left alone.
    await client.query(
      `DELETE FROM attempts
        WHERE user_id = $1::bigint
          AND id IN (
            SELECT aq.attempt_id
              FROM attempt_questions aq
              JOIN attempt_parts ap ON ap.attempt_question_id = aq.id
             WHERE ap.raw_answer LIKE $2
          )`,
      [pupilId, `${DEMO_SENTINEL}%`],
    );

    // `submitted_at` is set to "now" so the pupil review renders the
    // feedback block immediately — buildPupilFeedbackByPart suppresses
    // output when the attempt is still in progress.
    const { rows: attemptRows } = await client.query<{ id: string }>(
      `INSERT INTO attempts (user_id, class_id, mode, reveal_mode, submitted_at)
         VALUES ($1::bigint, $2::bigint, 'mixed', 'per_question', now())
         RETURNING id::text`,
      [pupilId, classId],
    );
    const attemptId = attemptRows[0]!.id;

    const attemptPartIds: { accepted: string; pending: string } = { accepted: '', pending: '' };

    for (const [order, def] of [PART_ACCEPTED, PART_PENDING].entries()) {
      const aq = await client.query<{ id: string }>(
        `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
           VALUES ($1::bigint, $2::bigint, $3)
         RETURNING id::text`,
        [attemptId, def.questionId, order + 1],
      );
      const aqId = aq.rows[0]!.id;
      const ap = await client.query<{ id: string }>(
        `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
           VALUES ($1::bigint, $2::bigint, $3)
         RETURNING id::text`,
        [aqId, def.partId, `${DEMO_SENTINEL} ${def.answer}`],
      );
      if (def === PART_ACCEPTED) attemptPartIds.accepted = ap.rows[0]!.id;
      else attemptPartIds.pending = ap.rows[0]!.id;
    }

    // Part A — visible AI feedback.
    await client.query(
      `INSERT INTO awarded_marks
         (attempt_part_id, marks_awarded, marks_total,
          mark_points_hit, mark_points_missed, evidence_quotes,
          marker, confidence, moderation_required, moderation_status,
          moderation_notes, prompt_version, model_id, feedback_for_pupil)
       VALUES ($1::bigint, $2, $3, $4::bigint[], $5::bigint[], $6::text[],
               'llm', 0.9, false, 'not_required',
               NULL, 'v0.1.0', 'demo-synthetic',
               $7::jsonb)`,
      [
        attemptPartIds.accepted,
        PART_ACCEPTED.marksAwarded,
        PART_ACCEPTED.marksTotal,
        PART_ACCEPTED.hitMarkPointIds,
        PART_ACCEPTED.missedMarkPointIds,
        [
          'fetches an instruction from RAM',
          'control unit decodes the instruction',
          'ALU executes it',
        ],
        JSON.stringify(PART_ACCEPTED.feedback),
      ],
    );

    // Part B — feedback written but held back until a teacher clears.
    await client.query(
      `INSERT INTO awarded_marks
         (attempt_part_id, marks_awarded, marks_total,
          mark_points_hit, mark_points_missed, evidence_quotes,
          marker, confidence, moderation_required, moderation_status,
          moderation_notes, prompt_version, model_id, feedback_for_pupil)
       VALUES ($1::bigint, $2, $3, $4::bigint[], $5::bigint[], $6::text[],
               'llm', 0.42, true, 'pending',
               $7::jsonb, 'v0.1.0', 'demo-synthetic',
               $8::jsonb)`,
      [
        attemptPartIds.pending,
        PART_PENDING.marksAwarded,
        PART_PENDING.marksTotal,
        PART_PENDING.hitMarkPointIds,
        PART_PENDING.missedMarkPointIds,
        [],
        JSON.stringify(PART_PENDING.moderationNotes),
        JSON.stringify(PART_PENDING.feedback),
      ],
    );

    await client.query('COMMIT');

    console.log('=== AI feedback demo seeded (synthetic, zero LLM spend) ===');
    console.log(`Attempt id:               ${attemptId}`);
    console.log(`Pupil:                    ${PUPIL_USERNAME}`);
    console.log('');
    console.log('Part A (visible feedback)');
    console.log(`  attempt_part_id:        ${attemptPartIds.accepted}`);
    console.log('  moderation_status:      not_required');
    console.log('  → pupil sees the three-header block on review.');
    console.log('');
    console.log('Part B (held back by safety gate)');
    console.log(`  attempt_part_id:        ${attemptPartIds.pending}`);
    console.log('  moderation_status:      pending');
    console.log('  → pupil does NOT see the block; admin sees the row at /admin/moderation.');
    console.log('');
    console.log('Log in as pupil1 / password-001 and open:');
    console.log(`  http://localhost:3030/attempts/${attemptId}`);
    console.log('Then clear the pending row at /admin/moderation and refresh the pupil page.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
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
