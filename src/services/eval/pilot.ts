// Chunk 3i. Pure rollup for pilot shadow-review pairs. Takes rows
// that have been joined by the CLI in scripts/eval/pilot-report.ts
// and produces the summary numbers the plan's exit criteria refer to:
//
//   PHASE3_PLAN.md §5 chunk 3i exit criteria:
//     - ≥ 85% of responses within ±1 mark of the teacher
//     - mean absolute error
//     - list every part where |AI − teacher| ≥ 2
//
// Kept IO-free so the unit test in tests/unit/eval-pilot.test.ts can
// drive it with fixed pair arrays without a DB.

export interface PilotReviewPair {
  readonly attemptPartId: string;
  readonly className: string;
  readonly pupilPseudonym: string;
  readonly topicCode: string | null;
  readonly partLabel: string;
  readonly aiMarks: number;
  readonly teacherMarks: number;
  readonly marksTotal: number;
  readonly confidence: number | null;
  readonly aiPromptVersion: string | null;
  readonly reviewedAt: Date;
  readonly reason: string;
}

export interface PilotSummary {
  readonly total: number;
  readonly meanAbsoluteError: number;
  readonly exactAgreement: number; // |delta| == 0
  readonly withinOne: number; // |delta| <= 1
  readonly overTwo: number; // |delta| >= 2
  readonly withinOneRate: number; // withinOne / total, 0 when total is 0
  readonly offenders: readonly PilotReviewPair[]; // |delta| >= 2, sorted by |delta| desc
}

export function summarisePilot(pairs: readonly PilotReviewPair[]): PilotSummary {
  const n = pairs.length;
  if (n === 0) {
    return {
      total: 0,
      meanAbsoluteError: 0,
      exactAgreement: 0,
      withinOne: 0,
      overTwo: 0,
      withinOneRate: 0,
      offenders: [],
    };
  }
  let exact = 0;
  let within = 0;
  let over = 0;
  let sumAbs = 0;
  for (const p of pairs) {
    const abs = Math.abs(p.teacherMarks - p.aiMarks);
    sumAbs += abs;
    if (abs === 0) exact += 1;
    if (abs <= 1) within += 1;
    if (abs >= 2) over += 1;
  }
  const offenders = [...pairs]
    .filter((p) => Math.abs(p.teacherMarks - p.aiMarks) >= 2)
    .sort((a, b) => Math.abs(b.teacherMarks - b.aiMarks) - Math.abs(a.teacherMarks - a.aiMarks));
  return {
    total: n,
    meanAbsoluteError: sumAbs / n,
    exactAgreement: exact,
    withinOne: within,
    overTwo: over,
    withinOneRate: within / n,
    offenders,
  };
}

const CSV_HEADER = [
  'attempt_part_id',
  'class',
  'pupil_pseudonym',
  'topic',
  'part',
  'ai_marks',
  'teacher_marks',
  'marks_total',
  'delta',
  'abs_delta',
  'confidence',
  'prompt_version',
  'reviewed_at',
  'reason',
];

function csvField(value: string | number | null): string {
  if (value === null) return '';
  const s = typeof value === 'number' ? String(value) : value;
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function renderPilotCsv(pairs: readonly PilotReviewPair[]): string {
  const lines: string[] = [];
  lines.push(CSV_HEADER.join(','));
  for (const p of pairs) {
    const delta = p.teacherMarks - p.aiMarks;
    lines.push(
      [
        csvField(p.attemptPartId),
        csvField(p.className),
        csvField(p.pupilPseudonym),
        csvField(p.topicCode),
        csvField(p.partLabel),
        csvField(p.aiMarks),
        csvField(p.teacherMarks),
        csvField(p.marksTotal),
        csvField(delta),
        csvField(Math.abs(delta)),
        csvField(p.confidence === null ? null : p.confidence.toFixed(2)),
        csvField(p.aiPromptVersion),
        csvField(p.reviewedAt.toISOString()),
        csvField(p.reason),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function renderPilotMarkdown(summary: PilotSummary, generatedAt: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`# Pilot shadow-review report — ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push(
    `**Reviewed:** ${summary.total} · **Mean abs. error:** ${summary.meanAbsoluteError.toFixed(2)} · **Within ±1:** ${summary.withinOne}/${summary.total} (${(summary.withinOneRate * 100).toFixed(1)}%)`,
  );
  lines.push('');
  lines.push('## Agreement distribution');
  lines.push('');
  lines.push(`- exact agreement: ${summary.exactAgreement}`);
  lines.push(`- within ±1: ${summary.withinOne}`);
  lines.push(`- disagreement ≥ 2: ${summary.overTwo}`);
  lines.push('');
  lines.push('## Exit-criteria check (PHASE3_PLAN.md §5)');
  lines.push('');
  const exitOk = summary.withinOneRate >= 0.85;
  lines.push(
    `- ≥ 85% within ±1 mark: ${exitOk ? 'PASS' : 'FAIL'} (${(summary.withinOneRate * 100).toFixed(1)}%)`,
  );
  if (summary.offenders.length > 0) {
    lines.push('');
    lines.push('## Parts where |AI − teacher| ≥ 2');
    lines.push('');
    lines.push('| Part | Class | Pupil | AI | Teacher | Δ |');
    lines.push('| ---- | ----- | ----- | -- | ------- | - |');
    for (const o of summary.offenders) {
      lines.push(
        `| ${o.attemptPartId} (${o.partLabel}) | ${o.className} | ${o.pupilPseudonym} | ${o.aiMarks} | ${o.teacherMarks} | ${o.teacherMarks - o.aiMarks} |`,
      );
    }
  }
  return lines.join('\n') + '\n';
}
