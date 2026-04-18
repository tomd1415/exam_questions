// Trace-grid parser, validator, marker, and authoring helpers. Pure —
// no DB, no IO. Used by:
//
//   * the trace_table widget template (renders one <input> per cell,
//     pre-filled cells become read-only text);
//   * the deterministic marker (per-cell exact match against
//     `expected`, with optional per-row or all-or-nothing aggregation);
//   * truth-table authoring (`generateTruthTablePrefill` produces the
//     `prefill` map for every 0/1 input combination over n vars).
//
// Pupil answers travel as line-encoded `r,c=value` blocks in
// `attempt_parts.raw_answer`. The widget posts one field per editable
// cell named `part_<partId>__<r>,<c>`; the route aggregator
// (src/routes/attempts.ts:495) turns those into the `r,c=value` lines.
// Pre-filled cells are not posted (the renderer reapplies them on the
// review page from `part_config.prefill`).
//
// `expected` is the author-supplied source of truth for marking. Cells
// that are neither in `prefill` nor in `expected` are decorative — they
// score nothing and never trigger an outcome. This shape covers both
// trace tables (variables × iterations) and truth tables (input columns
// prefilled with 2ⁿ rows, output columns expected).

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export interface TraceGridColumn {
  /** Column header. Non-empty. */
  name: string;
  /** Optional width hint in characters; renderer clamps to a sensible range. */
  width?: number;
}

export type TraceGridMarkingMode = 'perCell' | 'perRow' | 'allOrNothing';

export interface TraceGridMarking {
  /** Default 'perCell'. */
  mode: TraceGridMarkingMode;
  /** Default false — case is ignored unless this is explicitly true. */
  caseSensitive?: boolean;
  /** Default true — surrounding whitespace trimmed and runs collapsed. */
  trimWhitespace?: boolean;
}

export interface TraceGridConfig {
  columns: readonly TraceGridColumn[];
  /** Number of body rows (excluding the header). Positive integer. */
  rows: number;
  /**
   * Cells the author has filled in for the pupil. Keys are `"r,c"`
   * coordinates (0-indexed row and column, both within bounds).
   */
  prefill?: Readonly<Record<string, string>>;
  /**
   * Cells the pupil must complete. Keys are `"r,c"`. A coordinate may
   * not appear in both `prefill` and `expected`. Cells absent from
   * `expected` are decorative (no marks attached).
   */
  expected: Readonly<Record<string, string>>;
  marking: TraceGridMarking;
}

const COORD_RE = /^(\d+),(\d+)$/;

export function parseCoord(key: string): { r: number; c: number } | null {
  const m = COORD_RE.exec(key);
  if (!m) return null;
  const r = Number(m[1]);
  const c = Number(m[2]);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) return null;
  return { r, c };
}

export function coordKey(r: number, c: number): string {
  return `${r},${c}`;
}

export function isTraceGridConfig(c: unknown): c is TraceGridConfig {
  return validateTraceGridConfigShape(c).length === 0;
}

/**
 * Returns one human-readable issue per problem with `c`, or [] if it
 * is shaped correctly. Used by the widget registry and re-used by the
 * marker (a non-empty issues list = teacher_pending).
 */
export function validateTraceGridConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('trace_table part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const columns = cfg['columns'];
  const rows = cfg['rows'];
  const prefill = cfg['prefill'];
  const expected = cfg['expected'];
  const marking = cfg['marking'];

  let columnCount = 0;
  if (!Array.isArray(columns) || columns.length === 0) {
    issues.push('trace_table.columns must be a non-empty array.');
  } else {
    columnCount = columns.length;
    const seenNames = new Set<string>();
    for (let i = 0; i < columns.length; i += 1) {
      const col: unknown = columns[i];
      if (col === null || typeof col !== 'object' || Array.isArray(col)) {
        issues.push(`trace_table.columns[${i}] must be an object.`);
        continue;
      }
      const co = col as Record<string, unknown>;
      const name = co['name'];
      const width = co['width'];
      if (typeof name !== 'string' || name.length === 0) {
        issues.push(`trace_table.columns[${i}].name must be a non-empty string.`);
      } else if (seenNames.has(name)) {
        issues.push(`trace_table.columns[${i}].name '${name}' is duplicated.`);
      } else {
        seenNames.add(name);
      }
      if (width !== undefined && width !== null) {
        if (typeof width !== 'number' || !Number.isInteger(width) || width < 1) {
          issues.push(`trace_table.columns[${i}].width must be a positive integer if present.`);
        }
      }
      for (const key of Object.keys(co)) {
        if (key !== 'name' && key !== 'width') {
          issues.push(`trace_table.columns[${i}] has unsupported key '${key}'.`);
        }
      }
    }
  }

  let rowCount = 0;
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1) {
    issues.push('trace_table.rows must be a positive integer.');
  } else {
    rowCount = rows;
  }

  const prefillKeys = new Set<string>();
  if (prefill !== undefined && prefill !== null) {
    if (typeof prefill !== 'object' || Array.isArray(prefill)) {
      issues.push('trace_table.prefill must be an object map of "r,c" → string if present.');
    } else {
      for (const [key, value] of Object.entries(prefill as Record<string, unknown>)) {
        const coord = parseCoord(key);
        if (!coord) {
          issues.push(`trace_table.prefill key '${key}' must match /^\\d+,\\d+$/.`);
          continue;
        }
        if (rowCount > 0 && coord.r >= rowCount) {
          issues.push(`trace_table.prefill key '${key}' row out of range (rows=${rowCount}).`);
        }
        if (columnCount > 0 && coord.c >= columnCount) {
          issues.push(
            `trace_table.prefill key '${key}' column out of range (columns=${columnCount}).`,
          );
        }
        if (typeof value !== 'string' || value.length === 0) {
          issues.push(`trace_table.prefill['${key}'] must be a non-empty string.`);
        }
        prefillKeys.add(key);
      }
    }
  }

  if (expected === undefined || expected === null) {
    issues.push('trace_table.expected is required (use {} for an entirely teacher-marked grid).');
  } else if (typeof expected !== 'object' || Array.isArray(expected)) {
    issues.push('trace_table.expected must be an object map of "r,c" → string.');
  } else {
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      const coord = parseCoord(key);
      if (!coord) {
        issues.push(`trace_table.expected key '${key}' must match /^\\d+,\\d+$/.`);
        continue;
      }
      if (rowCount > 0 && coord.r >= rowCount) {
        issues.push(`trace_table.expected key '${key}' row out of range (rows=${rowCount}).`);
      }
      if (columnCount > 0 && coord.c >= columnCount) {
        issues.push(
          `trace_table.expected key '${key}' column out of range (columns=${columnCount}).`,
        );
      }
      if (typeof value !== 'string' || value.length === 0) {
        issues.push(`trace_table.expected['${key}'] must be a non-empty string.`);
      }
      if (prefillKeys.has(key)) {
        issues.push(`trace_table cell '${key}' appears in both prefill and expected.`);
      }
    }
  }

  if (marking === undefined || marking === null) {
    issues.push('trace_table.marking is required.');
  } else if (typeof marking !== 'object' || Array.isArray(marking)) {
    issues.push('trace_table.marking must be an object.');
  } else {
    const m = marking as Record<string, unknown>;
    const mode = m['mode'];
    const caseSensitive = m['caseSensitive'];
    const trimWhitespace = m['trimWhitespace'];
    if (mode !== 'perCell' && mode !== 'perRow' && mode !== 'allOrNothing') {
      issues.push("trace_table.marking.mode must be 'perCell', 'perRow', or 'allOrNothing'.");
    }
    if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
      issues.push('trace_table.marking.caseSensitive must be a boolean if present.');
    }
    if (trimWhitespace !== undefined && typeof trimWhitespace !== 'boolean') {
      issues.push('trace_table.marking.trimWhitespace must be a boolean if present.');
    }
    for (const key of Object.keys(m)) {
      if (key !== 'mode' && key !== 'caseSensitive' && key !== 'trimWhitespace') {
        issues.push(`trace_table.marking has unsupported key '${key}'.`);
      }
    }
  }

  for (const key of Object.keys(cfg)) {
    if (
      key !== 'columns' &&
      key !== 'rows' &&
      key !== 'prefill' &&
      key !== 'expected' &&
      key !== 'marking'
    ) {
      issues.push(`trace_table part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

/**
 * Parses the line-encoded `r,c=value` raw_answer into a Map keyed by
 * `"r,c"`. Last value wins for any repeated coordinate; blank values,
 * malformed lines, and non-integer coordinates are simply absent.
 */
export function parseTraceGridRawAnswer(rawAnswer: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    const coord = parseCoord(key);
    if (!coord) continue;
    if (value.length === 0) continue;
    out.set(key, value);
  }
  return out;
}

/**
 * Produces a stable `r,c=value` serialisation, sorted by row then
 * column, for an answers map. Used by the marker to emit a canonical
 * `normalised_answer` and by the review page to round-trip pupil input.
 */
export function serialiseTraceGridAnswer(answers: ReadonlyMap<string, string>): string {
  const entries = [...answers.entries()]
    .map(([key, value]) => {
      const coord = parseCoord(key);
      return coord ? { key, r: coord.r, c: coord.c, value } : null;
    })
    .filter((e): e is { key: string; r: number; c: number; value: string } => e !== null)
    .sort((a, b) => a.r - b.r || a.c - b.c);
  return entries.map((e) => `${e.key}=${e.value}`).join('\n');
}

function normaliseForMarking(value: string, marking: TraceGridMarking): string {
  let r = value;
  if (marking.trimWhitespace !== false) {
    r = r.trim().replace(/\s+/g, ' ');
  }
  if (marking.caseSensitive !== true) {
    r = r.toLowerCase();
  }
  return r;
}

export interface TraceGridCellOutcome {
  /** `"r,c"` coordinate. */
  key: string;
  r: number;
  c: number;
  hit: boolean;
  pupilAnswer: string;
  expected: string;
}

export interface TraceGridMarkResult {
  outcomes: readonly TraceGridCellOutcome[];
  /**
   * Hits awarded by the configured marking mode. For perCell this is
   * just the count of hit cells; for perRow it is the count of fully
   * correct rows × cells-in-that-row; for allOrNothing it is total
   * expected if every cell hits, else 0.
   */
  hits: number;
  /** Total expected cells (== total markable cells). */
  total: number;
}

export function markTraceGrid(
  config: TraceGridConfig,
  pupilAnswers: ReadonlyMap<string, string>,
): TraceGridMarkResult {
  const expectedKeys = Object.keys(config.expected);
  const outcomes: TraceGridCellOutcome[] = [];
  for (const key of expectedKeys) {
    const coord = parseCoord(key);
    if (!coord) continue;
    const expected = config.expected[key];
    if (typeof expected !== 'string') continue;
    const pupil = pupilAnswers.get(key) ?? '';
    const hit =
      pupil.length > 0 &&
      normaliseForMarking(pupil, config.marking) === normaliseForMarking(expected, config.marking);
    outcomes.push({ key, r: coord.r, c: coord.c, hit, pupilAnswer: pupil, expected });
  }
  outcomes.sort((a, b) => a.r - b.r || a.c - b.c);

  const total = outcomes.length;
  let hits = 0;
  if (config.marking.mode === 'perCell') {
    hits = outcomes.filter((o) => o.hit).length;
  } else if (config.marking.mode === 'allOrNothing') {
    hits = total > 0 && outcomes.every((o) => o.hit) ? total : 0;
  } else {
    const byRow = new Map<number, TraceGridCellOutcome[]>();
    for (const o of outcomes) {
      const bucket = byRow.get(o.r) ?? [];
      bucket.push(o);
      byRow.set(o.r, bucket);
    }
    for (const rowOutcomes of byRow.values()) {
      if (rowOutcomes.every((o) => o.hit)) hits += rowOutcomes.length;
    }
  }
  return { outcomes, hits, total };
}

/**
 * Generates a prefill map for a truth table over `varNames` input
 * variables. Produces 2ⁿ rows in big-endian order (the leftmost
 * variable is the most significant bit) with each variable's value
 * placed in the corresponding column. Throws if `varNames` is empty,
 * longer than 4 (J277 truth tables never exceed 3 inputs in practice),
 * or contains duplicate / blank names.
 *
 * Output columns are not generated — the author names them after
 * calling this and the pupil fills them in. Output cells become
 * `expected` entries; the wizard wires those up.
 */
export function generateTruthTablePrefill(varNames: readonly string[]): {
  prefill: Record<string, string>;
  rows: number;
} {
  if (varNames.length === 0) {
    throw new Error('generateTruthTablePrefill requires at least one variable name.');
  }
  if (varNames.length > 4) {
    throw new Error('generateTruthTablePrefill supports at most 4 input variables.');
  }
  const seen = new Set<string>();
  for (const n of varNames) {
    if (typeof n !== 'string' || n.trim().length === 0) {
      throw new Error('generateTruthTablePrefill variable names must be non-empty strings.');
    }
    if (seen.has(n)) {
      throw new Error(`generateTruthTablePrefill variable name '${n}' is duplicated.`);
    }
    seen.add(n);
  }
  const rows = 1 << varNames.length;
  const prefill: Record<string, string> = {};
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < varNames.length; c += 1) {
      // Big-endian: leftmost variable is the most significant bit.
      const bit = (r >> (varNames.length - 1 - c)) & 1;
      prefill[coordKey(r, c)] = String(bit);
    }
  }
  return { prefill, rows };
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('trace_table')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'trace_table'.");
  }
}
