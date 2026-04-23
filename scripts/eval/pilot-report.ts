/**
 * Pilot shadow-review rollup (Chunk 3i).
 *
 *   npm run pilot:report
 *
 * Joins every reviewed pilot row (awarded_marks.marker='llm' with
 * pilot_shadow_status='reviewed') against the teacher_override row
 * written in the same review transaction, and emits:
 *
 *   scripts/eval/out/pilot-{timestamp}.csv  — one row per reviewed part
 *   scripts/eval/out/pilot-{timestamp}.md   — human-readable summary
 *
 * stdout also carries the summary so the report can be inspected at
 * the end of a pilot week without opening a file. Exit code is 0 on
 * success, 1 if zero pilot rows have been reviewed (so CI / cron can
 * detect a silent pilot-off deploy).
 *
 * Reads only — no writes to the domain DB.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '../../src/db/pool.js';
import {
  renderPilotCsv,
  renderPilotMarkdown,
  summarisePilot,
  type PilotReviewPair,
} from '../../src/services/eval/pilot.js';

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(DIRNAME, 'out');

interface Row {
  attempt_part_id: string;
  class_name: string;
  pupil_pseudonym: string;
  topic_code: string | null;
  part_label: string;
  ai_marks: number;
  teacher_marks: number;
  marks_total: number;
  confidence: string | null;
  ai_prompt_version: string | null;
  reviewed_at: Date;
  reason: string;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<Row>(
    `SELECT ap.id::text           AS attempt_part_id,
            c.name                AS class_name,
            u.pseudonym           AS pupil_pseudonym,
            q.topic_code,
            qp.part_label,
            llm.marks_awarded     AS ai_marks,
            tov.new_marks_awarded AS teacher_marks,
            llm.marks_total,
            llm.confidence,
            llm.prompt_version    AS ai_prompt_version,
            tom.created_at        AS reviewed_at,
            tov.reason
       FROM awarded_marks llm
       JOIN attempt_parts ap      ON ap.id = llm.attempt_part_id
       JOIN question_parts qp     ON qp.id = ap.question_part_id
       JOIN attempt_questions aq  ON aq.id = ap.attempt_question_id
       JOIN questions q           ON q.id  = aq.question_id
       JOIN attempts a            ON a.id  = aq.attempt_id
       JOIN classes c             ON c.id  = a.class_id
       JOIN users u               ON u.id  = a.user_id
       JOIN awarded_marks tom     ON tom.attempt_part_id = ap.id AND tom.marker = 'teacher_override'
       JOIN teacher_overrides tov ON tov.awarded_mark_id = tom.id
      WHERE llm.marker = 'llm'
        AND llm.pilot_shadow_status = 'reviewed'
      ORDER BY tom.created_at ASC`,
  );

  const pairs: PilotReviewPair[] = rows.map((r) => ({
    attemptPartId: r.attempt_part_id,
    className: r.class_name,
    pupilPseudonym: r.pupil_pseudonym,
    topicCode: r.topic_code,
    partLabel: r.part_label,
    aiMarks: r.ai_marks,
    teacherMarks: r.teacher_marks,
    marksTotal: r.marks_total,
    confidence: r.confidence === null ? null : Number(r.confidence),
    aiPromptVersion: r.ai_prompt_version,
    reviewedAt: r.reviewed_at,
    reason: r.reason,
  }));

  const summary = summarisePilot(pairs);
  const generatedAt = new Date();
  const stamp = generatedAt.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  await fs.mkdir(OUT_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, `pilot-${stamp}.csv`);
  const mdPath = path.join(OUT_DIR, `pilot-${stamp}.md`);
  await fs.writeFile(csvPath, renderPilotCsv(pairs), 'utf8');
  await fs.writeFile(mdPath, renderPilotMarkdown(summary, generatedAt), 'utf8');

  console.log(`Reviewed pilot pairs: ${summary.total}`);
  console.log(`Mean abs. error:      ${summary.meanAbsoluteError.toFixed(2)}`);
  console.log(
    `Within ±1:            ${summary.withinOne}/${summary.total} (${(summary.withinOneRate * 100).toFixed(1)}%)`,
  );
  console.log(`Exact agreement:      ${summary.exactAgreement}`);
  console.log(`Disagreement ≥ 2:     ${summary.overTwo}`);
  console.log('');
  console.log(`CSV: ${csvPath}`);
  console.log(`MD:  ${mdPath}`);

  if (summary.total === 0) {
    console.warn(
      '\nNo reviewed pilot rows found. Either LLM_MARKING_PILOT was off, no teacher has opened /admin/moderation?mode=pilot, or the review flow did not persist. Exiting non-zero so cron surfaces this.',
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 2;
  })
  .finally(async () => {
    await pool.end();
  });
