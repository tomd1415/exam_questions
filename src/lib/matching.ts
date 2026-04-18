// Matching-widget parser, validator, and marker. Pure — no DB, no IO.
// Used by:
//
//   * the matching widget template (renders paired picker — SVG line
//     overlay on desktop, native <select> on mobile/assistive tech);
//   * the deterministic marker (compares the pupil's pairing against
//     `correctPairs`, with optional partial credit).
//
// Pupil answers travel as line-encoded `<leftIdx>=<rightIdx>` blocks in
// `attempt_parts.raw_answer`. The widget posts one field per left row
// named `part_<partId>__<leftIdx>`; the route aggregator
// (src/routes/attempts.ts:495) turns those into the `L=R` lines. Left
// rows the pupil has not paired are simply absent.
//
// `right` may be longer than `left` — the extra entries are distractors
// that are never part of any correct pair. A right entry may legitimately
// be the target of more than one left row (questions such as "match
// each device to a layer" often reuse a layer label).

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export interface MatchingConfig {
  /** Left-column prompts. Non-empty strings; at least one. */
  left: readonly string[];
  /** Right-column options. Non-empty strings; at least as many as `left`. */
  right: readonly string[];
  /**
   * Correct pairings as `[leftIndex, rightIndex]` tuples, one per left
   * row. Indices are 0-based and must be in range. A right index may
   * appear in more than one pair (shared answers), but a left index
   * must appear at most once (one answer per left row).
   */
  correctPairs: readonly (readonly [number, number])[];
  /**
   * When true (default), the marker awards one mark per correctly
   * paired left row, independently. When false, any wrong or missing
   * pair zeros the whole part.
   */
  partialCredit?: boolean;
}

export function isMatchingConfig(c: unknown): c is MatchingConfig {
  return validateMatchingConfigShape(c).length === 0;
}

/**
 * Returns one human-readable issue per problem with `c`, or [] if it
 * is shaped correctly. The widget registry wraps each message in a
 * `{ message }` object; the marker uses this directly as its gate for
 * falling back to teacher_pending.
 */
export function validateMatchingConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('matching part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const left = cfg['left'];
  const right = cfg['right'];
  const correctPairs = cfg['correctPairs'];
  const partialCredit = cfg['partialCredit'];

  let leftCount = 0;
  if (!Array.isArray(left) || left.length === 0) {
    issues.push('matching.left must be a non-empty string array.');
  } else if (!left.every((v) => typeof v === 'string' && v.length > 0)) {
    issues.push('matching.left entries must be non-empty strings.');
  } else if (new Set(left as string[]).size !== left.length) {
    issues.push('matching.left must not list the same prompt twice.');
  } else {
    leftCount = left.length;
  }

  let rightCount = 0;
  if (!Array.isArray(right) || right.length === 0) {
    issues.push('matching.right must be a non-empty string array.');
  } else if (!right.every((v) => typeof v === 'string' && v.length > 0)) {
    issues.push('matching.right entries must be non-empty strings.');
  } else if (new Set(right as string[]).size !== right.length) {
    issues.push('matching.right must not list the same option twice.');
  } else {
    rightCount = right.length;
    if (leftCount > 0 && rightCount < leftCount) {
      issues.push('matching.right must have at least as many entries as matching.left.');
    }
  }

  if (!Array.isArray(correctPairs)) {
    issues.push('matching.correctPairs must be an array of [leftIndex, rightIndex] tuples.');
  } else {
    const seenLeft = new Set<number>();
    if (leftCount > 0 && correctPairs.length !== leftCount) {
      issues.push(
        `matching.correctPairs must have exactly one entry per matching.left row (${leftCount}).`,
      );
    }
    for (let i = 0; i < correctPairs.length; i += 1) {
      const pair: unknown = correctPairs[i];
      if (!Array.isArray(pair) || pair.length !== 2) {
        issues.push(`matching.correctPairs[${i}] must be a [leftIndex, rightIndex] tuple.`);
        continue;
      }
      const [li, ri] = pair as unknown[];
      if (typeof li !== 'number' || !Number.isInteger(li) || li < 0) {
        issues.push(`matching.correctPairs[${i}][0] must be a non-negative integer.`);
        continue;
      }
      if (typeof ri !== 'number' || !Number.isInteger(ri) || ri < 0) {
        issues.push(`matching.correctPairs[${i}][1] must be a non-negative integer.`);
        continue;
      }
      if (leftCount > 0 && li >= leftCount) {
        issues.push(
          `matching.correctPairs[${i}][0]=${li} is out of range (left has ${leftCount}).`,
        );
      }
      if (rightCount > 0 && ri >= rightCount) {
        issues.push(
          `matching.correctPairs[${i}][1]=${ri} is out of range (right has ${rightCount}).`,
        );
      }
      if (seenLeft.has(li)) {
        issues.push(
          `matching.correctPairs reuses leftIndex ${li}; each left row must appear once.`,
        );
      } else {
        seenLeft.add(li);
      }
    }
  }

  if (partialCredit !== undefined && partialCredit !== null && typeof partialCredit !== 'boolean') {
    issues.push('matching.partialCredit must be a boolean if present.');
  }

  for (const key of Object.keys(cfg)) {
    if (key !== 'left' && key !== 'right' && key !== 'correctPairs' && key !== 'partialCredit') {
      issues.push(`matching part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

/**
 * Parses the line-encoded `L=R` raw_answer into a Map keyed by the
 * left index. Last value wins if a left row is repeated; blank or
 * malformed lines are ignored.
 */
export function parseMatchingRawAnswer(rawAnswer: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const leftStr = line.slice(0, eq).trim();
    const rightStr = line.slice(eq + 1).trim();
    if (!/^\d+$/.test(leftStr) || !/^\d+$/.test(rightStr)) continue;
    const li = Number(leftStr);
    const ri = Number(rightStr);
    if (!Number.isInteger(li) || !Number.isInteger(ri) || li < 0 || ri < 0) continue;
    out.set(li, ri);
  }
  return out;
}

/**
 * Emits a stable `L=R` serialisation sorted by left index. Used by the
 * marker to populate `normalised_answer` and by the review page to
 * round-trip pupil input.
 */
export function serialiseMatchingAnswer(pairs: ReadonlyMap<number, number>): string {
  return [...pairs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([l, r]) => `${l}=${r}`)
    .join('\n');
}

export interface MatchingOutcome {
  leftIndex: number;
  expectedRight: number;
  pickedRight: number | null;
  hit: boolean;
}

export interface MatchingMarkResult {
  outcomes: MatchingOutcome[];
  /** Number of left rows with `hit=true`. */
  hits: number;
  /** Length of `correctPairs` — one per left row. */
  total: number;
}

/**
 * Marks a pupil answer against a matching config. Out-of-range right
 * indices and picks that hit a distractor are simply incorrect; no
 * outcome is ever produced for rows that aren't in `correctPairs`.
 *
 * Aggregation (partial credit vs all-or-nothing) is the caller's job —
 * see `markAttemptPart` in `src/services/marking/deterministic.ts`. This
 * function always reports per-row truth.
 */
export function markMatching(
  config: MatchingConfig,
  pupilPairs: ReadonlyMap<number, number>,
): MatchingMarkResult {
  const rightCount = config.right.length;
  const outcomes: MatchingOutcome[] = [];
  let hits = 0;
  for (const [leftIndex, expectedRight] of config.correctPairs) {
    const pickedRaw = pupilPairs.get(leftIndex);
    const picked =
      pickedRaw !== undefined &&
      Number.isInteger(pickedRaw) &&
      pickedRaw >= 0 &&
      pickedRaw < rightCount
        ? pickedRaw
        : null;
    const hit = picked !== null && picked === expectedRight;
    if (hit) hits += 1;
    outcomes.push({
      leftIndex,
      expectedRight,
      pickedRight: pickedRaw ?? null,
      hit,
    });
  }
  return { outcomes, hits, total: config.correctPairs.length };
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('matching')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'matching'.");
  }
}
