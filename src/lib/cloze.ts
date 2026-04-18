// Cloze parser, marker, and summariser. Pure — no DB, no IO. Used by
// the cloze widget template (segment iteration), the deterministic
// marker (per-gap match), and the review page (gap-by-gap summary).
//
// Gap markers in the authored text have the form `{{gap-id}}`. A gap
// id must match /^[A-Za-z0-9_-]+$/ — no spaces, no punctuation other
// than dash and underscore. Literal double braces can be escaped as
// `\{{` and `\}}` if a question ever needs to print them.
//
// Pupil answers travel as line-encoded `gapId=value` blocks in
// `attempt_parts.raw_answer`, matching the convention already used by
// matrix_tick_*. The cloze widget is responsible for emitting one
// posted field per gap, named `part_<id>__<gapId>`, so the route
// aggregator (src/routes/attempts.ts) joins them into the correct
// raw_answer shape without any cloze-specific code.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export type ClozeSegment = { kind: 'text'; text: string } | { kind: 'gap'; id: string };

export interface ClozeGap {
  /** Gap id; must match /^[A-Za-z0-9_-]+$/ and be unique within a part. */
  id: string;
  /** Acceptable pupil answers (set match after normalisation). */
  accept: readonly string[];
  /** Default false — case is ignored unless this is explicitly true. */
  caseSensitive?: boolean;
  /** Default true — surrounding whitespace is trimmed and runs collapsed. */
  trimWhitespace?: boolean;
}

export interface ClozeConfig {
  /** Authored prose with `{{gap-id}}` markers. */
  text: string;
  /** One entry per unique gap id appearing in `text`. */
  gaps: readonly ClozeGap[];
  /**
   * Optional list of terms to render above the prose as a word bank.
   * Required when expected_response_type is 'cloze_with_bank'.
   */
  bank?: readonly string[];
}

export interface ClozeGapOutcome {
  id: string;
  hit: boolean;
  /** What the pupil typed (raw, before normalisation). */
  pupilAnswer: string;
  /** The accept list, surfaced to the review page. */
  acceptedAlternatives: readonly string[];
}

const GAP_ID_RE = /^[A-Za-z0-9_-]+$/;

export class ClozeParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'ClozeParseError';
    this.position = position;
  }
}

export function parseClozeText(text: string): ClozeSegment[] {
  const out: ClozeSegment[] = [];
  let buf = '';
  const flushBuf = (): void => {
    if (buf.length > 0) {
      out.push({ kind: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\{{', i)) {
      buf += '{{';
      i += 3;
      continue;
    }
    if (text.startsWith('\\}}', i)) {
      buf += '}}';
      i += 3;
      continue;
    }
    if (text.startsWith('{{', i)) {
      const close = text.indexOf('}}', i + 2);
      if (close === -1) {
        throw new ClozeParseError(`Unclosed gap marker starting at index ${i}.`, i);
      }
      const id = text.slice(i + 2, close).trim();
      if (id.length === 0) {
        throw new ClozeParseError(`Empty gap id at index ${i}.`, i);
      }
      if (!GAP_ID_RE.test(id)) {
        throw new ClozeParseError(
          `Invalid gap id '${id}' at index ${i} (allowed: letters, digits, '-', '_').`,
          i,
        );
      }
      flushBuf();
      out.push({ kind: 'gap', id });
      i = close + 2;
      continue;
    }
    buf += text[i];
    i += 1;
  }
  flushBuf();
  return out;
}

/** Lists every gap id appearing in `text`, in document order. */
export function gapIdsFromText(text: string): string[] {
  return parseClozeText(text)
    .filter((s): s is { kind: 'gap'; id: string } => s.kind === 'gap')
    .map((s) => s.id);
}

export function isClozeConfig(c: unknown): c is ClozeConfig {
  return validateClozeConfigShape(c, { requireBank: false }).length === 0;
}

export function isClozeWithBankConfig(c: unknown): c is ClozeConfig {
  return validateClozeConfigShape(c, { requireBank: true }).length === 0;
}

/**
 * Returns one human-readable issue per problem with `c` as a cloze
 * config, or [] if it is shaped correctly. Used by the widget registry
 * and re-used by the marker (a non-empty issues list = teacher_pending).
 */
export function validateClozeConfigShape(c: unknown, opts: { requireBank: boolean }): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('cloze part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;
  const text = cfg['text'];
  const gaps = cfg['gaps'];
  const bank = cfg['bank'];

  if (typeof text !== 'string' || text.length === 0) {
    issues.push('cloze.text must be a non-empty string.');
  }

  let textGapIds: string[] = [];
  if (typeof text === 'string') {
    try {
      textGapIds = gapIdsFromText(text);
    } catch (err) {
      issues.push(
        `cloze.text could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (textGapIds.length === 0 && issues.length === 0) {
      issues.push('cloze.text must contain at least one {{gap-id}} marker.');
    }
    if (new Set(textGapIds).size !== textGapIds.length) {
      issues.push('cloze.text repeats a gap id; each gap id must appear exactly once.');
    }
  }

  if (!Array.isArray(gaps) || gaps.length === 0) {
    issues.push('cloze.gaps must be a non-empty array.');
  } else {
    const seenIds = new Set<string>();
    for (let i = 0; i < gaps.length; i += 1) {
      const g: unknown = gaps[i];
      if (g === null || typeof g !== 'object' || Array.isArray(g)) {
        issues.push(`cloze.gaps[${i}] must be an object.`);
        continue;
      }
      const gap = g as Record<string, unknown>;
      const id = gap['id'];
      const accept = gap['accept'];
      const caseSensitive = gap['caseSensitive'];
      const trimWhitespace = gap['trimWhitespace'];
      if (typeof id !== 'string' || !GAP_ID_RE.test(id)) {
        issues.push(`cloze.gaps[${i}].id must match /^[A-Za-z0-9_-]+$/.`);
      } else if (seenIds.has(id)) {
        issues.push(`cloze.gaps[${i}].id '${id}' is duplicated within gaps.`);
      } else {
        seenIds.add(id);
      }
      if (
        !Array.isArray(accept) ||
        accept.length === 0 ||
        !accept.every((a): a is string => typeof a === 'string' && a.length > 0)
      ) {
        issues.push(`cloze.gaps[${i}].accept must be a non-empty array of non-empty strings.`);
      }
      if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
        issues.push(`cloze.gaps[${i}].caseSensitive must be a boolean if present.`);
      }
      if (trimWhitespace !== undefined && typeof trimWhitespace !== 'boolean') {
        issues.push(`cloze.gaps[${i}].trimWhitespace must be a boolean if present.`);
      }
    }
    if (textGapIds.length > 0) {
      const gapObjectIds = new Set(
        gaps
          .filter((g): g is Record<string, unknown> => g !== null && typeof g === 'object')
          .map((g) => g['id'])
          .filter((id): id is string => typeof id === 'string'),
      );
      for (const id of textGapIds) {
        if (!gapObjectIds.has(id)) {
          issues.push(`cloze.text references gap id '${id}' that has no entry in cloze.gaps.`);
        }
      }
      for (const id of gapObjectIds) {
        if (!textGapIds.includes(id)) {
          issues.push(`cloze.gaps id '${id}' does not appear in cloze.text.`);
        }
      }
    }
  }

  if (opts.requireBank) {
    if (!Array.isArray(bank) || bank.length === 0) {
      issues.push('cloze_with_bank requires bank to be a non-empty array of strings.');
    } else if (!bank.every((b): b is string => typeof b === 'string' && b.length > 0)) {
      issues.push('cloze_with_bank.bank entries must be non-empty strings.');
    } else if (new Set(bank).size !== bank.length) {
      issues.push('cloze_with_bank.bank must not list the same term twice.');
    }
  } else if (bank !== undefined && bank !== null) {
    if (!Array.isArray(bank)) {
      issues.push('cloze.bank must be an array of strings if present.');
    } else if (!bank.every((b): b is string => typeof b === 'string' && b.length > 0)) {
      issues.push('cloze.bank entries must be non-empty strings.');
    }
  }

  return issues;
}

/**
 * Parses the line-encoded `gapId=value` raw_answer into a Map. The first
 * value wins for any repeated id; blank values, malformed lines, and
 * unknown gap ids are simply absent from the result.
 */
export function parseClozeRawAnswer(rawAnswer: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const id = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!GAP_ID_RE.test(id)) continue;
    if (value.length === 0) continue;
    if (!out.has(id)) out.set(id, value);
  }
  return out;
}

function normaliseForGap(value: string, gap: ClozeGap): string {
  let r = value;
  const trim = gap.trimWhitespace !== false;
  if (trim) {
    r = r.trim().replace(/\s+/g, ' ');
  }
  if (gap.caseSensitive !== true) {
    r = r.toLowerCase();
  }
  return r;
}

export function markCloze(
  config: ClozeConfig,
  pupilAnswers: ReadonlyMap<string, string>,
): ClozeGapOutcome[] {
  return config.gaps.map((gap) => {
    const pupil = pupilAnswers.get(gap.id) ?? '';
    if (pupil.length === 0) {
      return { id: gap.id, hit: false, pupilAnswer: '', acceptedAlternatives: gap.accept };
    }
    const pupilNorm = normaliseForGap(pupil, gap);
    const hit = gap.accept.some((a) => normaliseForGap(a, gap) === pupilNorm);
    return { id: gap.id, hit, pupilAnswer: pupil, acceptedAlternatives: gap.accept };
  });
}

export interface ClozeSummary {
  total: number;
  filled: number;
  hits: number;
  outcomes: readonly ClozeGapOutcome[];
}

export function summariseCloze(
  config: ClozeConfig,
  pupilAnswers: ReadonlyMap<string, string>,
): ClozeSummary {
  const outcomes = markCloze(config, pupilAnswers);
  const filled = outcomes.filter((o) => o.pupilAnswer.length > 0).length;
  const hits = outcomes.filter((o) => o.hit).length;
  return { total: outcomes.length, filled, hits, outcomes };
}

// Module-load guard: keeps the cloze types in sync with the central list.
{
  const required = ['cloze_free', 'cloze_with_bank', 'cloze_code'];
  for (const t of required) {
    if (!EXPECTED_RESPONSE_TYPES.includes(t)) {
      throw new Error(`EXPECTED_RESPONSE_TYPES is missing cloze response type '${t}'.`);
    }
  }
}
