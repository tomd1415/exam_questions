import {
  isClozeConfig,
  isClozeWithBankConfig,
  markCloze,
  parseClozeRawAnswer,
} from '../../lib/cloze.js';
import { normalise } from './normalise.js';

// Pure deterministic marker. No DB, no HTTP, no LLM. Feed it a part, a
// raw answer, and the part's mark points; get back either an awarded
// total (objective types) or a teacher_pending marker (open types).

export const OBJECTIVE_RESPONSE_TYPES = new Set<string>([
  'multiple_choice',
  'tick_box',
  'short_text',
  'matrix_tick_single',
  'matrix_tick_multi',
  'cloze_free',
  'cloze_with_bank',
  'cloze_code',
]);

export const OPEN_RESPONSE_TYPES = new Set<string>([
  'medium_text',
  'extended_response',
  'code',
  'algorithm',
  'trace_table',
]);

export interface MarkingInputPart {
  marks: number;
  expected_response_type: string;
  // Widget-specific configuration mirrored from question_parts.part_config.
  // Optional for back-compat — every widget that needs it reads its own
  // shape internally. Existing types ignore this field.
  part_config?: unknown;
}

export interface MarkingInputMarkPoint {
  text: string;
  accepted_alternatives: readonly string[];
  marks: number;
  is_required: boolean;
}

export interface MarkPointOutcome {
  text: string;
  marks: number;
  is_required: boolean;
  hit: boolean;
}

export type MarkingResult =
  | {
      kind: 'awarded';
      marks_awarded: number;
      marks_possible: number;
      mark_point_outcomes: MarkPointOutcome[];
      normalised_answer: string;
    }
  | { kind: 'teacher_pending'; marks_possible: number; reason: 'open_response' | 'unknown_type' };

export function markAttemptPart(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
): MarkingResult {
  const type = part.expected_response_type;

  if (OPEN_RESPONSE_TYPES.has(type)) {
    return { kind: 'teacher_pending', marks_possible: part.marks, reason: 'open_response' };
  }
  if (!OBJECTIVE_RESPONSE_TYPES.has(type)) {
    return { kind: 'teacher_pending', marks_possible: part.marks, reason: 'unknown_type' };
  }

  if (type === 'multiple_choice') return markMultipleChoice(part, rawAnswer, markPoints);
  if (type === 'tick_box') return markTickBox(part, rawAnswer, markPoints);
  if (type === 'matrix_tick_single') return markMatrixTickSingle(part, rawAnswer, markPoints);
  if (type === 'matrix_tick_multi') return markMatrixTickMulti(part, rawAnswer, markPoints);
  if (type === 'cloze_free' || type === 'cloze_with_bank' || type === 'cloze_code') {
    return markClozePart(part, rawAnswer, markPoints, type);
  }
  return markShortText(part, rawAnswer, markPoints);
}

function markMultipleChoice(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
): MarkingResult {
  const answer = normalise(rawAnswer);
  const outcomes = markPoints.map<MarkPointOutcome>((mp) => ({
    text: mp.text,
    marks: mp.marks,
    is_required: mp.is_required,
    hit: answer.length > 0 && candidateMatchesExact(answer, mp),
  }));

  const awarded = outcomes.filter((o) => o.hit).reduce((sum, o) => sum + o.marks, 0);
  return {
    kind: 'awarded',
    marks_awarded: clampMarks(awarded, part.marks),
    marks_possible: part.marks,
    mark_point_outcomes: outcomes,
    normalised_answer: answer,
  };
}

function markTickBox(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
): MarkingResult {
  const ticks = rawAnswer
    .split(/[\n,]/)
    .map((s) => normalise(s))
    .filter((s) => s.length > 0);

  const outcomes: MarkPointOutcome[] = [];
  const matchedTicks = new Set<number>();
  for (const mp of markPoints) {
    let hit = false;
    for (let i = 0; i < ticks.length; i++) {
      if (matchedTicks.has(i)) continue;
      if (candidateMatchesExact(ticks[i]!, mp)) {
        matchedTicks.add(i);
        hit = true;
        break;
      }
    }
    outcomes.push({ text: mp.text, marks: mp.marks, is_required: mp.is_required, hit });
  }

  const correctTicks = matchedTicks.size;
  const incorrectTicks = ticks.length - correctTicks;
  const rawAward = Math.max(0, correctTicks - incorrectTicks);
  const hitWeight = outcomes.filter((o) => o.hit).reduce((sum, o) => sum + o.marks, 0);
  const awarded = Math.min(rawAward, hitWeight);
  return {
    kind: 'awarded',
    marks_awarded: clampMarks(enforceRequired(awarded, outcomes), part.marks),
    marks_possible: part.marks,
    mark_point_outcomes: outcomes,
    normalised_answer: ticks.join('\n'),
  };
}

function markShortText(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
): MarkingResult {
  const answer = normalise(rawAnswer);
  const outcomes = markPoints.map<MarkPointOutcome>((mp) => ({
    text: mp.text,
    marks: mp.marks,
    is_required: mp.is_required,
    hit: answer.length > 0 && candidateContains(answer, mp),
  }));

  const hitMarks = outcomes.filter((o) => o.hit).reduce((sum, o) => sum + o.marks, 0);
  return {
    kind: 'awarded',
    marks_awarded: clampMarks(enforceRequired(hitMarks, outcomes), part.marks),
    marks_possible: part.marks,
    mark_point_outcomes: outcomes,
    normalised_answer: answer,
  };
}

function candidateMatchesExact(normalisedAnswer: string, mp: MarkingInputMarkPoint): boolean {
  if (normalisedAnswer === normalise(mp.text)) return true;
  for (const alt of mp.accepted_alternatives) {
    if (normalisedAnswer === normalise(alt)) return true;
  }
  return false;
}

function candidateContains(normalisedAnswer: string, mp: MarkingInputMarkPoint): boolean {
  const normalisedText = normalise(mp.text);
  if (normalisedText.length > 0 && normalisedAnswer.includes(normalisedText)) return true;
  for (const alt of mp.accepted_alternatives) {
    const n = normalise(alt);
    if (n.length > 0 && normalisedAnswer.includes(n)) return true;
  }
  return false;
}

function enforceRequired(awarded: number, outcomes: readonly MarkPointOutcome[]): number {
  for (const o of outcomes) {
    if (o.is_required && !o.hit) return 0;
  }
  return awarded;
}

function clampMarks(awarded: number, possible: number): number {
  return awarded > possible ? possible : awarded;
}

// matrix_tick_single
//
// raw_answer encodes one selection per row, one row per line, in the
// shape `<row-index>=<column-label>`. Examples:
//   0=Disk
//   1=RAM
// Rows the pupil left blank are simply absent from raw_answer.
//
// `part.part_config` carries `{ rows: string[], columns: string[],
// correctByRow: string[], allOrNothing?: boolean }`. The marker compares
// each row's selection to `correctByRow[i]` and awards one mark per
// match (or zero if `allOrNothing` is true and any row is wrong).
//
// `markPoints` is expected to contain one entry per row, in row order;
// each entry's text labels the row for the review page. The marker
// produces a per-row hit/miss outcome list that lines up with that
// ordering.

interface MatrixTickConfig {
  rows: readonly string[];
  columns: readonly string[];
  correctByRow: readonly string[];
  allOrNothing?: boolean;
}

function isMatrixTickConfig(c: unknown): c is MatrixTickConfig {
  if (c === null || typeof c !== 'object') return false;
  const cfg = c as Record<string, unknown>;
  const rows = cfg['rows'];
  const columns = cfg['columns'];
  const correctByRow = cfg['correctByRow'];
  const allOrNothing = cfg['allOrNothing'];
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'string')) return false;
  if (!Array.isArray(columns) || !columns.every((c2) => typeof c2 === 'string')) return false;
  if (!Array.isArray(correctByRow) || !correctByRow.every((c2) => typeof c2 === 'string'))
    return false;
  if (correctByRow.length !== rows.length) return false;
  if (allOrNothing !== undefined && allOrNothing !== null && typeof allOrNothing !== 'boolean')
    return false;
  return true;
}

export function parseMatrixTickRawAnswer(rawAnswer: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const idxStr = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^\d+$/.test(idxStr)) continue;
    const idx = Number(idxStr);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (value.length === 0) continue;
    if (!out.has(idx)) out.set(idx, value);
  }
  return out;
}

function markMatrixTickSingle(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
): MarkingResult {
  const config = part.part_config;
  if (!isMatrixTickConfig(config)) {
    return { kind: 'teacher_pending', marks_possible: part.marks, reason: 'unknown_type' };
  }

  const selections = parseMatrixTickRawAnswer(rawAnswer);
  const expectedNorm = config.correctByRow.map((c) => normalise(c));
  const validColumns = new Set(config.columns.map((c) => normalise(c)));

  const outcomes: MarkPointOutcome[] = config.rows.map((_, i) => {
    const picked = selections.get(i);
    const pickedNorm = picked === undefined ? '' : normalise(picked);
    const inRange = pickedNorm.length > 0 && validColumns.has(pickedNorm);
    const hit = inRange && pickedNorm === expectedNorm[i];
    const mp = markPoints[i];
    return {
      text: mp ? mp.text : `Row ${i + 1}`,
      marks: mp ? mp.marks : 1,
      is_required: mp ? mp.is_required : false,
      hit,
    };
  });

  const hitMarks = outcomes.filter((o) => o.hit).reduce((sum, o) => sum + o.marks, 0);
  const allHit = outcomes.length > 0 && outcomes.every((o) => o.hit);
  const awardedRaw = config.allOrNothing === true ? (allHit ? hitMarks : 0) : hitMarks;
  return {
    kind: 'awarded',
    marks_awarded: clampMarks(enforceRequired(awardedRaw, outcomes), part.marks),
    marks_possible: part.marks,
    mark_point_outcomes: outcomes,
    normalised_answer: [...selections.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, v]) => `${i}=${v}`)
      .join('\n'),
  };
}

// matrix_tick_multi
//
// raw_answer encodes one selection per line, in the shape
// `<row-index>=<column-label>`. A row may legitimately contribute
// multiple lines if the pupil ticked more than one column; rows the
// pupil left blank are absent.
//
// `part.part_config` carries `{ rows: string[], columns: string[],
// correctByRow: string[][], partialCredit?: boolean }`. `correctByRow[i]`
// lists every column that should be ticked on row `i`. `partialCredit`
// defaults to true: under-ticking awards proportional credit per row,
// over-ticking (any wrong tick on a row) zeros that row's marks.
//
// `markPoints` should contain one entry per (row, correctColumn) pair,
// in row-then-column order (matching `correctByRow` flattened). Each
// outcome lines up with that index — useful for the review page.

interface MatrixTickMultiConfig {
  rows: readonly string[];
  columns: readonly string[];
  correctByRow: readonly (readonly string[])[];
  partialCredit?: boolean;
}

function isMatrixTickMultiConfig(c: unknown): c is MatrixTickMultiConfig {
  if (c === null || typeof c !== 'object') return false;
  const cfg = c as Record<string, unknown>;
  const rows = cfg['rows'];
  const columns = cfg['columns'];
  const correctByRow = cfg['correctByRow'];
  const partialCredit = cfg['partialCredit'];
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'string')) return false;
  if (!Array.isArray(columns) || !columns.every((c2) => typeof c2 === 'string')) return false;
  if (!Array.isArray(correctByRow)) return false;
  if (correctByRow.length !== rows.length) return false;
  for (const row of correctByRow) {
    if (!Array.isArray(row)) return false;
    if (!row.every((c2) => typeof c2 === 'string')) return false;
  }
  if (partialCredit !== undefined && partialCredit !== null && typeof partialCredit !== 'boolean')
    return false;
  return true;
}

export function parseMatrixTickMultiRawAnswer(rawAnswer: string): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const idxStr = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^\d+$/.test(idxStr)) continue;
    const idx = Number(idxStr);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (value.length === 0) continue;
    let bucket = out.get(idx);
    if (!bucket) {
      bucket = new Set<string>();
      out.set(idx, bucket);
    }
    bucket.add(value);
  }
  return out;
}

function markMatrixTickMulti(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
): MarkingResult {
  const config = part.part_config;
  if (!isMatrixTickMultiConfig(config)) {
    return { kind: 'teacher_pending', marks_possible: part.marks, reason: 'unknown_type' };
  }

  const selections = parseMatrixTickMultiRawAnswer(rawAnswer);
  const validColsNorm = new Set(config.columns.map((c) => normalise(c)));
  const partialCredit = config.partialCredit !== false;

  const outcomes: MarkPointOutcome[] = [];
  let mpIndex = 0;
  const acceptedByRow = new Map<number, string[]>();

  for (let i = 0; i < config.rows.length; i++) {
    const correctList = config.correctByRow[i] ?? [];
    const correctNormSet = new Set(correctList.map((c) => normalise(c)));
    const rawPicks = selections.get(i) ?? new Set<string>();
    const pickedNormSet = new Set<string>();
    for (const p of rawPicks) {
      const n = normalise(p);
      if (validColsNorm.has(n)) pickedNormSet.add(n);
    }

    let hasIncorrect = false;
    for (const p of pickedNormSet) {
      if (!correctNormSet.has(p)) {
        hasIncorrect = true;
        break;
      }
    }
    const setEquals =
      !hasIncorrect &&
      pickedNormSet.size === correctNormSet.size &&
      [...pickedNormSet].every((p) => correctNormSet.has(p));
    const rowAwards = !hasIncorrect && (partialCredit || setEquals);

    for (const correctCol of correctList) {
      const correctColNorm = normalise(correctCol);
      const mp = markPoints[mpIndex];
      const hit = rowAwards && pickedNormSet.has(correctColNorm);
      outcomes.push({
        text: mp ? mp.text : `${config.rows[i]}: ${correctCol}`,
        marks: mp ? mp.marks : 1,
        is_required: mp ? mp.is_required : false,
        hit,
      });
      mpIndex++;
    }
    if (rawPicks.size > 0) acceptedByRow.set(i, [...rawPicks].sort());
  }

  const hitMarks = outcomes.filter((o) => o.hit).reduce((sum, o) => sum + o.marks, 0);
  const normalisedAnswer: string[] = [];
  const sortedRows = [...acceptedByRow.entries()].sort((a, b) => a[0] - b[0]);
  for (const [i, vs] of sortedRows) {
    for (const v of vs) normalisedAnswer.push(`${i}=${v}`);
  }
  return {
    kind: 'awarded',
    marks_awarded: clampMarks(enforceRequired(hitMarks, outcomes), part.marks),
    marks_possible: part.marks,
    mark_point_outcomes: outcomes,
    normalised_answer: normalisedAnswer.join('\n'),
  };
}

// cloze_free / cloze_with_bank / cloze_code
//
// raw_answer encodes one line per filled gap, in the shape
// `<gap-id>=<value>`. Empty gaps are omitted.
//
// `part.part_config` carries `{ text, gaps, bank? }` (see src/lib/cloze.ts
// for the full shape). `cloze_with_bank` additionally requires a non-empty
// `bank` of optional drag-or-tap terms.
//
// `markPoints` should contain one entry per gap, in document order. The
// marker generates a per-gap outcome; if `markPoints` runs short, the
// gap id stands in for the missing label so the review page still names
// the gap.

function markClozePart(
  part: MarkingInputPart,
  rawAnswer: string,
  markPoints: readonly MarkingInputMarkPoint[],
  type: 'cloze_free' | 'cloze_with_bank' | 'cloze_code',
): MarkingResult {
  const config = part.part_config;
  if (type === 'cloze_with_bank') {
    if (!isClozeWithBankConfig(config)) {
      return { kind: 'teacher_pending', marks_possible: part.marks, reason: 'unknown_type' };
    }
  } else if (!isClozeConfig(config)) {
    return { kind: 'teacher_pending', marks_possible: part.marks, reason: 'unknown_type' };
  }

  const pupilAnswers = parseClozeRawAnswer(rawAnswer);
  const gapOutcomes = markCloze(config, pupilAnswers);

  const outcomes: MarkPointOutcome[] = gapOutcomes.map((g, i) => {
    const mp = markPoints[i];
    return {
      text: mp ? mp.text : `Gap ${g.id}`,
      marks: mp ? mp.marks : 1,
      is_required: mp ? mp.is_required : false,
      hit: g.hit,
    };
  });

  const hitMarks = outcomes.filter((o) => o.hit).reduce((sum, o) => sum + o.marks, 0);
  const normalisedLines: string[] = [];
  for (const g of gapOutcomes) {
    if (g.pupilAnswer.length > 0) normalisedLines.push(`${g.id}=${g.pupilAnswer}`);
  }
  return {
    kind: 'awarded',
    marks_awarded: clampMarks(enforceRequired(hitMarks, outcomes), part.marks),
    marks_possible: part.marks,
    mark_point_outcomes: outcomes,
    normalised_answer: normalisedLines.join('\n'),
  };
}
