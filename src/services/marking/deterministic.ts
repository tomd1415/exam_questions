import { normalise } from './normalise.js';

// Pure deterministic marker. No DB, no HTTP, no LLM. Feed it a part, a
// raw answer, and the part's mark points; get back either an awarded
// total (objective types) or a teacher_pending marker (open types).

export const OBJECTIVE_RESPONSE_TYPES = new Set<string>([
  'multiple_choice',
  'tick_box',
  'short_text',
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
