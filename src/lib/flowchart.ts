// Flowchart widget — Phase 2.5.
//
// Two authoring variants share the `flowchart` expected_response_type:
//
//   * `image` (the 2.5h MVP): pupil draws a flowchart freehand on a
//     <canvas> and ships the result as a base64-encoded PNG. Marker is
//     teacher_pending.
//
//   * `shapes` (chunk 2.5k): teacher places pre-drawn flowchart shapes
//     (terminator / process / decision / io) on a canvas; some shapes
//     are prefilled with text, others are blanks the pupil must fill in.
//     Arrows between shapes are rendered decoratively. Marker is
//     deterministic — per expected shape the pupil's answer is
//     set-matched against an `accept` list, mirroring diagram_labels.
//
// Pupil answers travel as a single line for the image variant:
//
//     image=data:image/png;base64,<base64chars>
//
// …and as one `<shapeId>=<text>` line per filled expected shape for the
// shapes variant. The route aggregator (src/routes/attempts.ts) already
// collapses suffixed form fields into that shape.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export type FlowchartVariant = 'image' | 'shapes';

export const SUPPORTED_FLOWCHART_VARIANTS: readonly FlowchartVariant[] = ['image', 'shapes'];

export type FlowchartShapeType = 'terminator' | 'process' | 'decision' | 'io';

export const FLOWCHART_SHAPE_TYPES: readonly FlowchartShapeType[] = [
  'terminator',
  'process',
  'decision',
  'io',
];

export interface FlowchartShapePrefilled {
  id: string;
  type: FlowchartShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Prefilled decorative text (the pupil cannot edit this). */
  text: string;
}

export interface FlowchartShapeExpected {
  id: string;
  type: FlowchartShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Accepted pupil answers; compared after case/whitespace normalisation. */
  accept: readonly string[];
  caseSensitive?: boolean;
  trimWhitespace?: boolean;
}

export type FlowchartShape = FlowchartShapePrefilled | FlowchartShapeExpected;

export interface FlowchartArrow {
  from: string;
  to: string;
  /** Optional branch label (e.g. "Yes"/"No" on a decision). */
  label?: string;
}

export interface FlowchartImageConfig {
  variant: 'image';
  canvas: { width: number; height: number };
}

export interface FlowchartShapesConfig {
  variant: 'shapes';
  canvas: { width: number; height: number };
  shapes: readonly FlowchartShape[];
  arrows: readonly FlowchartArrow[];
}

export type FlowchartConfig = FlowchartImageConfig | FlowchartShapesConfig;

/** Hard cap on the length of a stored image data URL (≈ 600 KB after base64). */
export const MAX_FLOWCHART_DATA_URL_LENGTH = 600_000;

/** Required prefix on every accepted data URL (image variant). */
export const FLOWCHART_DATA_URL_PREFIX = 'data:image/png;base64,';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isFlowchartConfig(c: unknown): c is FlowchartConfig {
  return validateFlowchartConfigShape(c).length === 0;
}

export function isFlowchartShapeExpected(s: FlowchartShape): s is FlowchartShapeExpected {
  return 'accept' in s;
}

function isCanvas(c: unknown, prefix: string, issues: string[]): { w: number; h: number } {
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push(`${prefix}.canvas must be an object with width and height.`);
    return { w: 0, h: 0 };
  }
  const cv = c as Record<string, unknown>;
  const w = cv['width'];
  const h = cv['height'];
  let ok = true;
  if (typeof w !== 'number' || !Number.isInteger(w) || w < 100 || w > 2000) {
    issues.push(`${prefix}.canvas.width must be an integer between 100 and 2000.`);
    ok = false;
  }
  if (typeof h !== 'number' || !Number.isInteger(h) || h < 100 || h > 2000) {
    issues.push(`${prefix}.canvas.height must be an integer between 100 and 2000.`);
    ok = false;
  }
  for (const key of Object.keys(cv)) {
    if (key !== 'width' && key !== 'height') {
      issues.push(`${prefix}.canvas has unsupported key '${key}'.`);
    }
  }
  if (!ok) return { w: 0, h: 0 };
  return { w: w as number, h: h as number };
}

export function validateFlowchartConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('flowchart part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const variant = cfg['variant'];
  if (typeof variant !== 'string') {
    issues.push(
      `flowchart.variant is required (one of: ${SUPPORTED_FLOWCHART_VARIANTS.join(', ')}).`,
    );
    return issues;
  }
  if (!SUPPORTED_FLOWCHART_VARIANTS.includes(variant as FlowchartVariant)) {
    issues.push(
      `flowchart.variant '${variant}' is not supported (expected one of: ${SUPPORTED_FLOWCHART_VARIANTS.join(', ')}).`,
    );
    return issues;
  }

  const { w: canvasW, h: canvasH } = isCanvas(cfg['canvas'], 'flowchart', issues);

  if (variant === 'image') {
    for (const key of Object.keys(cfg)) {
      if (key !== 'variant' && key !== 'canvas') {
        issues.push(`flowchart has unsupported key '${key}' for the 'image' variant.`);
      }
    }
    return issues;
  }

  // variant === 'shapes'
  const shapes = cfg['shapes'];
  const arrows = cfg['arrows'];

  const seenShapeIds = new Set<string>();
  const expectedSeen = new Set<string>();

  if (!Array.isArray(shapes) || shapes.length === 0) {
    issues.push('flowchart.shapes must be a non-empty array.');
  } else {
    for (let i = 0; i < shapes.length; i += 1) {
      const raw: unknown = shapes[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`flowchart.shapes[${i}] must be an object.`);
        continue;
      }
      const s = raw as Record<string, unknown>;
      const id = s['id'];
      const type = s['type'];
      const x = s['x'];
      const y = s['y'];
      const w = s['width'];
      const h = s['height'];
      const text = s['text'];
      const accept = s['accept'];
      const caseSensitive = s['caseSensitive'];
      const trimWhitespace = s['trimWhitespace'];

      if (typeof id !== 'string' || !ID_RE.test(id)) {
        issues.push(`flowchart.shapes[${i}].id must match ${ID_RE.source} (e.g. 'start', 's1').`);
      } else if (seenShapeIds.has(id)) {
        issues.push(`flowchart.shapes reuses id '${id}'; ids must be unique.`);
      } else {
        seenShapeIds.add(id);
      }

      if (typeof type !== 'string' || !FLOWCHART_SHAPE_TYPES.includes(type as FlowchartShapeType)) {
        issues.push(
          `flowchart.shapes[${i}].type must be one of: ${FLOWCHART_SHAPE_TYPES.join(', ')}.`,
        );
      }

      const isNonNegInt = (v: unknown): v is number =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0;

      if (!isNonNegInt(x)) {
        issues.push(`flowchart.shapes[${i}].x must be a non-negative integer.`);
      }
      if (!isNonNegInt(y)) {
        issues.push(`flowchart.shapes[${i}].y must be a non-negative integer.`);
      }
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 40) {
        issues.push(`flowchart.shapes[${i}].width must be an integer ≥ 40.`);
      }
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 30) {
        issues.push(`flowchart.shapes[${i}].height must be an integer ≥ 30.`);
      }
      if (canvasW > 0 && isNonNegInt(x) && typeof w === 'number' && x + w > canvasW) {
        issues.push(`flowchart.shapes[${i}] extends past canvas width.`);
      }
      if (canvasH > 0 && isNonNegInt(y) && typeof h === 'number' && y + h > canvasH) {
        issues.push(`flowchart.shapes[${i}] extends past canvas height.`);
      }

      const hasText = typeof text === 'string';
      const hasAccept = accept !== undefined;
      if (hasText === hasAccept) {
        issues.push(
          `flowchart.shapes[${i}] must have exactly one of 'text' (prefilled) or 'accept' (pupil-fill).`,
        );
      }
      if (hasText && text.length === 0) {
        issues.push(`flowchart.shapes[${i}].text must be a non-empty string.`);
      }
      if (hasAccept) {
        if (!Array.isArray(accept) || accept.length === 0) {
          issues.push(`flowchart.shapes[${i}].accept must be a non-empty string array.`);
        } else if (!accept.every((v) => typeof v === 'string' && v.length > 0)) {
          issues.push(`flowchart.shapes[${i}].accept entries must be non-empty strings.`);
        } else if (typeof id === 'string') {
          expectedSeen.add(id);
        }
      }

      if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
        issues.push(`flowchart.shapes[${i}].caseSensitive must be a boolean if present.`);
      }
      if (trimWhitespace !== undefined && typeof trimWhitespace !== 'boolean') {
        issues.push(`flowchart.shapes[${i}].trimWhitespace must be a boolean if present.`);
      }

      for (const key of Object.keys(s)) {
        if (
          key !== 'id' &&
          key !== 'type' &&
          key !== 'x' &&
          key !== 'y' &&
          key !== 'width' &&
          key !== 'height' &&
          key !== 'text' &&
          key !== 'accept' &&
          key !== 'caseSensitive' &&
          key !== 'trimWhitespace'
        ) {
          issues.push(`flowchart.shapes[${i}] has unsupported key '${key}'.`);
        }
      }
    }
    if (expectedSeen.size === 0) {
      issues.push(
        "flowchart.shapes must contain at least one shape with 'accept' (a pupil-fill blank).",
      );
    }
  }

  if (arrows === undefined) {
    issues.push('flowchart.arrows is required (may be an empty array if there are no connectors).');
  } else if (!Array.isArray(arrows)) {
    issues.push('flowchart.arrows must be an array.');
  } else {
    for (let i = 0; i < arrows.length; i += 1) {
      const raw: unknown = arrows[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`flowchart.arrows[${i}] must be an object.`);
        continue;
      }
      const a = raw as Record<string, unknown>;
      const from = a['from'];
      const to = a['to'];
      const label = a['label'];
      if (typeof from !== 'string' || !seenShapeIds.has(from)) {
        issues.push(`flowchart.arrows[${i}].from must reference an existing shape id.`);
      }
      if (typeof to !== 'string' || !seenShapeIds.has(to)) {
        issues.push(`flowchart.arrows[${i}].to must reference an existing shape id.`);
      }
      if (label !== undefined && (typeof label !== 'string' || label.length === 0)) {
        issues.push(`flowchart.arrows[${i}].label must be a non-empty string if present.`);
      }
      for (const key of Object.keys(a)) {
        if (key !== 'from' && key !== 'to' && key !== 'label') {
          issues.push(`flowchart.arrows[${i}] has unsupported key '${key}'.`);
        }
      }
    }
  }

  for (const key of Object.keys(cfg)) {
    if (key !== 'variant' && key !== 'canvas' && key !== 'shapes' && key !== 'arrows') {
      issues.push(`flowchart part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

// ---------- image variant raw_answer ----------

export interface ParsedFlowchartImageAnswer {
  image: string | null;
  errors: string[];
}

export function parseFlowchartRawAnswer(rawAnswer: string): ParsedFlowchartImageAnswer {
  const errors: string[] = [];
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) {
    return { image: null, errors };
  }
  let imageLine: string | null = null;
  for (const line of rawAnswer.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push('flowchart raw_answer line missing "key=value" separator.');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === 'image') {
      imageLine = value;
    } else {
      errors.push(`flowchart raw_answer has unknown key '${key}'.`);
    }
  }
  if (imageLine === null) {
    return { image: null, errors };
  }
  if (imageLine.length > MAX_FLOWCHART_DATA_URL_LENGTH) {
    errors.push(`flowchart image exceeds ${MAX_FLOWCHART_DATA_URL_LENGTH} characters; rejected.`);
    return { image: null, errors };
  }
  if (!imageLine.startsWith(FLOWCHART_DATA_URL_PREFIX)) {
    errors.push(`flowchart image must start with '${FLOWCHART_DATA_URL_PREFIX}'.`);
    return { image: null, errors };
  }
  const payload = imageLine.slice(FLOWCHART_DATA_URL_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    errors.push('flowchart image base64 payload is malformed.');
    return { image: null, errors };
  }
  return { image: imageLine, errors };
}

export function serialiseFlowchartAnswer(image: string | null): string {
  if (image === null || image.length === 0) return '';
  return `image=${image}`;
}

// ---------- shapes variant raw_answer ----------

/**
 * Parses the line-encoded raw_answer into a Map keyed by shape id. Last
 * value wins if a shape id is repeated; malformed lines are ignored.
 */
export function parseFlowchartShapesRawAnswer(rawAnswer: string): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) return out;
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!ID_RE.test(key)) continue;
    out.set(key, value);
  }
  return out;
}

/** Emits `id=value` lines in shape order, skipping prefilled/blank shapes. */
export function serialiseFlowchartShapesAnswer(
  config: FlowchartShapesConfig,
  pupilFills: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const s of config.shapes) {
    if (!isFlowchartShapeExpected(s)) continue;
    const v = pupilFills.get(s.id);
    if (v === undefined || v.length === 0) continue;
    lines.push(`${s.id}=${v}`);
  }
  return lines.join('\n');
}

// ---------- shapes variant marking ----------

function normaliseShapeAnswer(value: string, s: FlowchartShapeExpected): string {
  let v = value;
  if (s.trimWhitespace !== false) v = v.trim();
  if (s.caseSensitive !== true) v = v.toLowerCase();
  return v;
}

export interface FlowchartShapeOutcome {
  shapeId: string;
  pupilValue: string | null;
  hit: boolean;
}

export interface FlowchartShapesMarkResult {
  outcomes: FlowchartShapeOutcome[];
  hits: number;
  total: number;
}

/**
 * Marks a pupil answer against a flowchart shapes config. One mark per
 * expected shape the pupil filled correctly; blanks never hit.
 */
export function markFlowchartShapes(
  config: FlowchartShapesConfig,
  pupilFills: ReadonlyMap<string, string>,
): FlowchartShapesMarkResult {
  const outcomes: FlowchartShapeOutcome[] = [];
  let hits = 0;
  let total = 0;
  for (const s of config.shapes) {
    if (!isFlowchartShapeExpected(s)) continue;
    total += 1;
    const raw = pupilFills.get(s.id);
    if (raw === undefined || raw.length === 0) {
      outcomes.push({ shapeId: s.id, pupilValue: null, hit: false });
      continue;
    }
    const normPupil = normaliseShapeAnswer(raw, s);
    const hit = s.accept.some((a) => normaliseShapeAnswer(a, s) === normPupil);
    if (hit) hits += 1;
    outcomes.push({ shapeId: s.id, pupilValue: raw, hit });
  }
  return { outcomes, hits, total };
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('flowchart')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'flowchart'.");
  }
}
