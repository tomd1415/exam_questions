// Decides how an attempt_parts.raw_answer should render on a
// marking / review surface (admin attempt detail, admin moderation,
// admin pilot shadow review, pupil attempt review). Every template
// that surfaces a pupil answer should route through this function —
// a raw `<pre>` of the encoded answer is unreadable for structured
// widgets (matching, matrix_tick_*, trace_table, cloze, diagram_labels)
// and useless for image widgets (flowchart / logic_diagram, where
// the raw value is `image=data:image/png;base64,…`).
//
// The shape matrix:
//   - empty / blank pupil answer       → { kind: 'empty' }
//   - image-variant drawing widgets    → { kind: 'image', dataUrl, alt }
//   - matching                         → { kind: 'rows' } with left-prompt rows + answer text
//   - matrix_tick_single / multi       → { kind: 'rows' } with row-label rows + selected column(s)
//   - diagram_labels                   → { kind: 'rows' } with hotspot labels + pupil labels
//   - cloze_* (free / with_bank / code) → { kind: 'rows' } with gap id/prompt rows + pupil text
//   - trace_table                      → { kind: 'grid' } with the 2D cell values
//   - medium_text / extended_response / code / algorithm / anything
//     else                             → { kind: 'text', text }
//
// Authored labels (left prompts, column names, hotspot ids, gap ids)
// come from `part_config`; decoders are intentionally lenient — if
// part_config is malformed or absent, we fall through to the text
// branch rather than crashing the render. The templates never need
// to decode raw_answer themselves.

import { parseMatchingRawAnswer } from './matching.js';
import { parseTraceGridRawAnswer } from './trace-grid.js';
import { parseClozeRawAnswer } from './cloze.js';
import { parseDiagramLabelsRawAnswer } from './diagram-labels.js';
import { parseMatrixTickRawAnswer } from '../services/marking/deterministic.js';

// The current widget editors serialise a drawing as
// `image=data:image/png;base64,<payload>`. Older pupil answers in the
// production DB may have been written by an earlier widget version
// that omitted the `image=` prefix or used a different MIME type
// (jpeg, svg+xml, webp). Both shapes are safe to render — a data URL
// IS a complete <img src> — so we pattern-match on either, plus a
// permissive MIME-type list. This is defence in depth: if a teacher
// reports they still see a base64 string for a pre-existing answer,
// they're hitting a shape this list doesn't yet cover, and we add
// it here. Adding shapes is always cheaper than guessing them right
// the first time. See AUDIT_2026-04-23.md for the chunk 3i pilot
// context that surfaced this.
const KEYED_IMAGE_LINE_PREFIX = 'image=data:image/';
const RAW_IMAGE_LINE_PREFIX = 'data:image/';
const RECOGNISED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

export interface PupilAnswerRow {
  readonly label: string;
  readonly value: string;
  readonly blank: boolean;
}

export interface PupilAnswerGridCell {
  readonly value: string;
  readonly blank: boolean;
  readonly prefilled: boolean;
}

export type PupilAnswerView =
  | { kind: 'empty' }
  | { kind: 'image'; dataUrl: string; alt: string }
  | { kind: 'rows'; heading: string; rows: readonly PupilAnswerRow[] }
  | {
      kind: 'grid';
      heading: string;
      columns: readonly string[];
      rows: readonly (readonly PupilAnswerGridCell[])[];
    }
  | { kind: 'text'; text: string };

function isEmpty(raw: string | null | undefined): raw is null | undefined | '' {
  return raw === null || raw === undefined || raw.length === 0;
}

function firstNonBlankLine(raw: string): string {
  return raw.split('\n').find((line) => line.length > 0) ?? '';
}

// Pulls a `data:image/<mime>;...` URL out of the first line of a
// raw_answer if it represents a drawing. Returns null otherwise.
// Handles both shapes produced by the widget set:
//   image=data:image/png;base64,…   ← current widget editors
//   data:image/png;base64,…         ← legacy / future variants
// and the wider MIME set listed in RECOGNISED_MIME_TYPES (jpeg,
// gif, webp, svg+xml) so older or differently-encoded drawings
// surface as <img> rather than as a wall of base64 text.
function extractImageDataUrl(firstLine: string): string | null {
  let candidate: string | null = null;
  if (firstLine.startsWith(KEYED_IMAGE_LINE_PREFIX)) {
    candidate = firstLine.slice('image='.length);
  } else if (firstLine.startsWith(RAW_IMAGE_LINE_PREFIX)) {
    candidate = firstLine;
  }
  if (candidate === null) return null;
  // Only return the URL if the MIME type is one we trust. A bare
  // `data:image/foo` from an unknown source is more likely garbage
  // than a real drawing — falling through to the text branch keeps
  // the teacher seeing the raw answer rather than a broken <img>.
  for (const mime of RECOGNISED_MIME_TYPES) {
    if (candidate.startsWith(`data:${mime}`)) return candidate;
  }
  return null;
}

function nonBlank(s: string): boolean {
  return s !== undefined && s !== null && s.trim().length > 0;
}

// Convenience for routes that render an AttemptBundle. Walks every
// attempt_part and returns a Map keyed by attempt_part_id. Templates
// then read the decoded view directly from the map — no
// function-through-view-context dependency, so a route forgetting
// to pass the helper cannot 500 the page.
export interface AttemptPartLike {
  readonly id: string;
  readonly raw_answer: string;
  readonly expected_response_type: string;
  readonly part_config: unknown;
}

export function buildPupilAnswerViewMap(
  partsByQuestion: Iterable<readonly AttemptPartLike[]>,
): Map<string, PupilAnswerView> {
  const out = new Map<string, PupilAnswerView>();
  for (const list of partsByQuestion) {
    for (const part of list) {
      out.set(
        part.id,
        buildPupilAnswerView(part.raw_answer, part.expected_response_type, part.part_config),
      );
    }
  }
  return out;
}

export function buildPupilAnswerView(
  rawAnswer: string | null | undefined,
  expectedResponseType: string | null | undefined,
  partConfig: unknown = null,
): PupilAnswerView {
  if (isEmpty(rawAnswer)) return { kind: 'empty' };

  const firstLine = firstNonBlankLine(rawAnswer);
  const imageDataUrl = extractImageDataUrl(firstLine);
  if (imageDataUrl !== null) {
    return {
      kind: 'image',
      dataUrl: imageDataUrl,
      alt: `Pupil's drawn answer (${expectedResponseType ?? 'widget'})`,
    };
  }

  const cfg = isObject(partConfig) ? (partConfig as Record<string, unknown>) : null;

  if (expectedResponseType === 'matching' && cfg) {
    const view = decodeMatching(rawAnswer, cfg);
    if (view) return view;
  }
  if (expectedResponseType === 'matrix_tick_single' && cfg) {
    const view = decodeMatrixTickSingle(rawAnswer, cfg);
    if (view) return view;
  }
  if (expectedResponseType === 'matrix_tick_multi' && cfg) {
    const view = decodeMatrixTickMulti(rawAnswer, cfg);
    if (view) return view;
  }
  if (expectedResponseType === 'diagram_labels' && cfg) {
    const view = decodeDiagramLabels(rawAnswer, cfg);
    if (view) return view;
  }
  if (
    (expectedResponseType === 'cloze_free' ||
      expectedResponseType === 'cloze_with_bank' ||
      expectedResponseType === 'cloze_code') &&
    cfg
  ) {
    const view = decodeCloze(rawAnswer, cfg);
    if (view) return view;
  }
  if (expectedResponseType === 'trace_table' && cfg) {
    const view = decodeTraceTable(rawAnswer, cfg);
    if (view) return view;
  }

  return { kind: 'text', text: rawAnswer };
}

function isObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asStringArray(v: unknown): readonly string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as readonly string[];
}

function decodeMatching(rawAnswer: string, cfg: Record<string, unknown>): PupilAnswerView | null {
  const left = asStringArray(cfg['left']);
  const right = asStringArray(cfg['right']);
  if (!left || !right) return null;
  const map = parseMatchingRawAnswer(rawAnswer);
  const rows: PupilAnswerRow[] = left.map((prompt, idx) => {
    const rightIdx = map.get(idx);
    if (rightIdx === undefined || right[rightIdx] === undefined) {
      return { label: prompt, value: '(not paired)', blank: true };
    }
    return { label: prompt, value: right[rightIdx], blank: false };
  });
  return { kind: 'rows', heading: 'Pupil matched:', rows };
}

function decodeMatrixTickSingle(
  rawAnswer: string,
  cfg: Record<string, unknown>,
): PupilAnswerView | null {
  const rowsCfg = asStringArray(cfg['rows']);
  if (!rowsCfg) return null;
  const selected = parseMatrixTickRawAnswer(rawAnswer);
  const rows: PupilAnswerRow[] = rowsCfg.map((label, idx) => {
    const pick = selected.get(idx);
    if (!nonBlank(pick ?? '')) {
      return { label, value: '(no selection)', blank: true };
    }
    return { label, value: pick!, blank: false };
  });
  return { kind: 'rows', heading: 'Pupil ticked:', rows };
}

function decodeMatrixTickMulti(
  rawAnswer: string,
  cfg: Record<string, unknown>,
): PupilAnswerView | null {
  const rowsCfg = asStringArray(cfg['rows']);
  if (!rowsCfg) return null;
  // matrix_tick_multi allows CSV-style multiple ticks per row; the
  // deterministic parser drops duplicates, so splitting on `,` here
  // is just to pretty-print the values the pupil actually sent.
  const perRow = parseMatrixTickRawAnswer(rawAnswer);
  const rows: PupilAnswerRow[] = rowsCfg.map((label, idx) => {
    const pick = perRow.get(idx);
    if (!nonBlank(pick ?? '')) {
      return { label, value: '(no selections)', blank: true };
    }
    const parts = pick!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { label, value: parts.join(', '), blank: parts.length === 0 };
  });
  return { kind: 'rows', heading: 'Pupil ticked:', rows };
}

function decodeDiagramLabels(
  rawAnswer: string,
  cfg: Record<string, unknown>,
): PupilAnswerView | null {
  const hotspots = cfg['hotspots'];
  if (!Array.isArray(hotspots)) return null;
  const values = parseDiagramLabelsRawAnswer(rawAnswer);
  const rows: PupilAnswerRow[] = [];
  for (const h of hotspots) {
    if (!isObject(h)) continue;
    const hot = h as Record<string, unknown>;
    const id = typeof hot['id'] === 'string' ? hot['id'] : null;
    if (!id) continue;
    const value = values.get(id);
    if (!nonBlank(value ?? '')) {
      rows.push({ label: id, value: '(unlabelled)', blank: true });
    } else {
      rows.push({ label: id, value: value!, blank: false });
    }
  }
  if (rows.length === 0) return null;
  return { kind: 'rows', heading: 'Pupil labelled:', rows };
}

function decodeCloze(rawAnswer: string, cfg: Record<string, unknown>): PupilAnswerView | null {
  const gaps = cfg['gaps'];
  if (!Array.isArray(gaps)) return null;
  const values = parseClozeRawAnswer(rawAnswer);
  const rows: PupilAnswerRow[] = [];
  for (const g of gaps) {
    if (!isObject(g)) continue;
    const gap = g as Record<string, unknown>;
    const id = typeof gap['id'] === 'string' ? gap['id'] : null;
    if (!id) continue;
    const value = values.get(id);
    if (!nonBlank(value ?? '')) {
      rows.push({ label: id, value: '(left blank)', blank: true });
    } else {
      rows.push({ label: id, value: value!, blank: false });
    }
  }
  if (rows.length === 0) return null;
  return { kind: 'rows', heading: 'Pupil filled:', rows };
}

function decodeTraceTable(rawAnswer: string, cfg: Record<string, unknown>): PupilAnswerView | null {
  const columns = Array.isArray(cfg['columns'])
    ? (cfg['columns'] as unknown[])
        .map((c) => (isObject(c) ? ((c as Record<string, unknown>)['name'] as string) : null))
        .filter((n): n is string => typeof n === 'string')
    : null;
  const rowCount = typeof cfg['rows'] === 'number' ? cfg['rows'] : null;
  if (!columns || columns.length === 0 || rowCount === null || rowCount <= 0) return null;

  const prefill = isObject(cfg['prefill']) ? (cfg['prefill'] as Record<string, string>) : {};
  const pupilValues = parseTraceGridRawAnswer(rawAnswer);

  const cells: PupilAnswerGridCell[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: PupilAnswerGridCell[] = [];
    for (let c = 0; c < columns.length; c++) {
      const key = `${r},${c}`;
      const pre = typeof prefill[key] === 'string' ? prefill[key] : undefined;
      if (pre !== undefined) {
        row.push({ value: pre, blank: false, prefilled: true });
        continue;
      }
      const v = pupilValues.get(key);
      if (!nonBlank(v ?? '')) {
        row.push({ value: '', blank: true, prefilled: false });
      } else {
        row.push({ value: v!, blank: false, prefilled: false });
      }
    }
    cells.push(row);
  }
  return { kind: 'grid', heading: 'Pupil trace:', columns, rows: cells };
}
