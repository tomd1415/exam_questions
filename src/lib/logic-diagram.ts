// Logic-diagram widget — Phase 2.5.
//
// Two authoring variants share the `logic_diagram` expected_response_type:
//
//   * `image` (the 2.5f MVP): pupil draws a logic diagram freehand on a
//     <canvas> and ships the result as a base64-encoded PNG. Marker is
//     teacher_pending.
//
//   * `gate_in_box` (chunk 2.5l): teacher lays out labelled input/output
//     terminals and a mix of prefilled gates (AND/OR/NOT) and blank
//     "boxes" that the pupil must name. Wires between gates/terminals
//     are rendered decoratively. Marker is deterministic — per blank the
//     pupil's answer is set-matched against an `accept` list, mirroring
//     flowchart shapes and diagram_labels.
//
// Pupil answers travel as a single line for the image variant:
//
//     image=data:image/png;base64,<base64chars>
//
// …and as one `<gateId>=<text>` line per filled blank for the
// gate_in_box variant. The route aggregator (src/routes/attempts.ts)
// already collapses suffixed form fields into that shape.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export type LogicDiagramVariant = 'image' | 'gate_in_box';

export const SUPPORTED_LOGIC_DIAGRAM_VARIANTS: readonly LogicDiagramVariant[] = [
  'image',
  'gate_in_box',
];

export type LogicGateType = 'AND' | 'OR' | 'NOT';

export const LOGIC_GATE_TYPES: readonly LogicGateType[] = ['AND', 'OR', 'NOT'];

export interface LogicGatePrefilled {
  id: string;
  /** Gate glyph to render. */
  type: LogicGateType;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LogicGateBlank {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Accepted pupil answers; compared after case/whitespace normalisation. */
  accept: readonly string[];
  caseSensitive?: boolean;
  trimWhitespace?: boolean;
}

export type LogicGate = LogicGatePrefilled | LogicGateBlank;

export type LogicTerminalKind = 'input' | 'output';

export interface LogicTerminal {
  id: string;
  kind: LogicTerminalKind;
  /** Short label (e.g. "A", "B", "P"). */
  label: string;
  x: number;
  y: number;
}

export interface LogicWire {
  from: string;
  to: string;
}

export interface LogicDiagramImageConfig {
  variant: 'image';
  canvas: { width: number; height: number };
}

export interface LogicDiagramGateInBoxConfig {
  variant: 'gate_in_box';
  canvas: { width: number; height: number };
  gates: readonly LogicGate[];
  terminals: readonly LogicTerminal[];
  wires: readonly LogicWire[];
}

export type LogicDiagramConfig = LogicDiagramImageConfig | LogicDiagramGateInBoxConfig;

/** Hard cap on the length of a stored data URL (≈ 600 KB after base64). */
export const MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH = 600_000;

/** Required prefix on every accepted data URL. */
export const LOGIC_DIAGRAM_DATA_URL_PREFIX = 'data:image/png;base64,';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function isLogicDiagramConfig(c: unknown): c is LogicDiagramConfig {
  return validateLogicDiagramConfigShape(c).length === 0;
}

export function isLogicGateBlank(g: LogicGate): g is LogicGateBlank {
  return 'accept' in g;
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

export function validateLogicDiagramConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('logic_diagram part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const variant = cfg['variant'];
  if (typeof variant !== 'string') {
    issues.push(
      `logic_diagram.variant is required (one of: ${SUPPORTED_LOGIC_DIAGRAM_VARIANTS.join(', ')}).`,
    );
    return issues;
  }
  if (!SUPPORTED_LOGIC_DIAGRAM_VARIANTS.includes(variant as LogicDiagramVariant)) {
    issues.push(
      `logic_diagram.variant '${variant}' is not supported (expected one of: ${SUPPORTED_LOGIC_DIAGRAM_VARIANTS.join(', ')}).`,
    );
    return issues;
  }

  const { w: canvasW, h: canvasH } = isCanvas(cfg['canvas'], 'logic_diagram', issues);

  if (variant === 'image') {
    for (const key of Object.keys(cfg)) {
      if (key !== 'variant' && key !== 'canvas') {
        issues.push(`logic_diagram has unsupported key '${key}' for the 'image' variant.`);
      }
    }
    return issues;
  }

  // variant === 'gate_in_box'
  const gates = cfg['gates'];
  const terminals = cfg['terminals'];
  const wires = cfg['wires'];

  const seenIds = new Set<string>();
  let blankCount = 0;

  const isNonNegInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0;

  if (!Array.isArray(gates) || gates.length === 0) {
    issues.push('logic_diagram.gates must be a non-empty array.');
  } else {
    for (let i = 0; i < gates.length; i += 1) {
      const raw: unknown = gates[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`logic_diagram.gates[${i}] must be an object.`);
        continue;
      }
      const g = raw as Record<string, unknown>;
      const id = g['id'];
      const type = g['type'];
      const x = g['x'];
      const y = g['y'];
      const w = g['width'];
      const h = g['height'];
      const accept = g['accept'];
      const caseSensitive = g['caseSensitive'];
      const trimWhitespace = g['trimWhitespace'];

      if (typeof id !== 'string' || !ID_RE.test(id)) {
        issues.push(`logic_diagram.gates[${i}].id must match ${ID_RE.source}.`);
      } else if (seenIds.has(id)) {
        issues.push(`logic_diagram reuses id '${id}'; gate/terminal ids must be unique.`);
      } else {
        seenIds.add(id);
      }

      if (!isNonNegInt(x)) {
        issues.push(`logic_diagram.gates[${i}].x must be a non-negative integer.`);
      }
      if (!isNonNegInt(y)) {
        issues.push(`logic_diagram.gates[${i}].y must be a non-negative integer.`);
      }
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 40) {
        issues.push(`logic_diagram.gates[${i}].width must be an integer ≥ 40.`);
      }
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 30) {
        issues.push(`logic_diagram.gates[${i}].height must be an integer ≥ 30.`);
      }
      if (canvasW > 0 && isNonNegInt(x) && typeof w === 'number' && x + w > canvasW) {
        issues.push(`logic_diagram.gates[${i}] extends past canvas width.`);
      }
      if (canvasH > 0 && isNonNegInt(y) && typeof h === 'number' && y + h > canvasH) {
        issues.push(`logic_diagram.gates[${i}] extends past canvas height.`);
      }

      const hasType = type !== undefined;
      const hasAccept = accept !== undefined;
      if (hasType === hasAccept) {
        issues.push(
          `logic_diagram.gates[${i}] must have exactly one of 'type' (prefilled gate) or 'accept' (pupil-fill blank).`,
        );
      }
      if (hasType) {
        if (typeof type !== 'string' || !LOGIC_GATE_TYPES.includes(type as LogicGateType)) {
          issues.push(
            `logic_diagram.gates[${i}].type must be one of: ${LOGIC_GATE_TYPES.join(', ')}.`,
          );
        }
      }
      if (hasAccept) {
        if (!Array.isArray(accept) || accept.length === 0) {
          issues.push(`logic_diagram.gates[${i}].accept must be a non-empty string array.`);
        } else if (!accept.every((v) => typeof v === 'string' && v.length > 0)) {
          issues.push(`logic_diagram.gates[${i}].accept entries must be non-empty strings.`);
        } else {
          blankCount += 1;
        }
      }

      if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
        issues.push(`logic_diagram.gates[${i}].caseSensitive must be a boolean if present.`);
      }
      if (trimWhitespace !== undefined && typeof trimWhitespace !== 'boolean') {
        issues.push(`logic_diagram.gates[${i}].trimWhitespace must be a boolean if present.`);
      }

      for (const key of Object.keys(g)) {
        if (
          key !== 'id' &&
          key !== 'type' &&
          key !== 'x' &&
          key !== 'y' &&
          key !== 'width' &&
          key !== 'height' &&
          key !== 'accept' &&
          key !== 'caseSensitive' &&
          key !== 'trimWhitespace'
        ) {
          issues.push(`logic_diagram.gates[${i}] has unsupported key '${key}'.`);
        }
      }
    }
    if (blankCount === 0) {
      issues.push(
        "logic_diagram.gates must contain at least one gate with 'accept' (a pupil-fill blank).",
      );
    }
  }

  if (terminals === undefined) {
    issues.push('logic_diagram.terminals is required (may be an empty array).');
  } else if (!Array.isArray(terminals)) {
    issues.push('logic_diagram.terminals must be an array.');
  } else {
    for (let i = 0; i < terminals.length; i += 1) {
      const raw: unknown = terminals[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`logic_diagram.terminals[${i}] must be an object.`);
        continue;
      }
      const t = raw as Record<string, unknown>;
      const id = t['id'];
      const kind = t['kind'];
      const label = t['label'];
      const x = t['x'];
      const y = t['y'];

      if (typeof id !== 'string' || !ID_RE.test(id)) {
        issues.push(`logic_diagram.terminals[${i}].id must match ${ID_RE.source}.`);
      } else if (seenIds.has(id)) {
        issues.push(`logic_diagram reuses id '${id}'; gate/terminal ids must be unique.`);
      } else {
        seenIds.add(id);
      }
      if (kind !== 'input' && kind !== 'output') {
        issues.push(`logic_diagram.terminals[${i}].kind must be 'input' or 'output'.`);
      }
      if (typeof label !== 'string' || label.length === 0 || label.length > 8) {
        issues.push(`logic_diagram.terminals[${i}].label must be a 1–8 character string.`);
      }
      if (!isNonNegInt(x) || (canvasW > 0 && x > canvasW)) {
        issues.push(`logic_diagram.terminals[${i}].x must fit inside the canvas.`);
      }
      if (!isNonNegInt(y) || (canvasH > 0 && y > canvasH)) {
        issues.push(`logic_diagram.terminals[${i}].y must fit inside the canvas.`);
      }
      for (const key of Object.keys(t)) {
        if (key !== 'id' && key !== 'kind' && key !== 'label' && key !== 'x' && key !== 'y') {
          issues.push(`logic_diagram.terminals[${i}] has unsupported key '${key}'.`);
        }
      }
    }
  }

  if (wires === undefined) {
    issues.push('logic_diagram.wires is required (may be an empty array).');
  } else if (!Array.isArray(wires)) {
    issues.push('logic_diagram.wires must be an array.');
  } else {
    for (let i = 0; i < wires.length; i += 1) {
      const raw: unknown = wires[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`logic_diagram.wires[${i}] must be an object.`);
        continue;
      }
      const wire = raw as Record<string, unknown>;
      const from = wire['from'];
      const to = wire['to'];
      if (typeof from !== 'string' || !seenIds.has(from)) {
        issues.push(`logic_diagram.wires[${i}].from must reference an existing gate/terminal id.`);
      }
      if (typeof to !== 'string' || !seenIds.has(to)) {
        issues.push(`logic_diagram.wires[${i}].to must reference an existing gate/terminal id.`);
      }
      for (const key of Object.keys(wire)) {
        if (key !== 'from' && key !== 'to') {
          issues.push(`logic_diagram.wires[${i}] has unsupported key '${key}'.`);
        }
      }
    }
  }

  for (const key of Object.keys(cfg)) {
    if (
      key !== 'variant' &&
      key !== 'canvas' &&
      key !== 'gates' &&
      key !== 'terminals' &&
      key !== 'wires'
    ) {
      issues.push(`logic_diagram part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

// ---------- image variant raw_answer ----------

export interface ParsedLogicDiagramImageAnswer {
  image: string | null;
  errors: string[];
}

/**
 * Parses the line-encoded raw_answer. A well-formed answer is a single
 * `image=<dataURL>` line with a `data:image/png;base64,…` payload. Any
 * other shape yields `image: null` plus one or more error strings; the
 * caller decides how to surface them (the marker treats it as "nothing
 * to mark", the template falls back to a blank canvas).
 */
export function parseLogicDiagramRawAnswer(rawAnswer: string): ParsedLogicDiagramImageAnswer {
  const errors: string[] = [];
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) {
    return { image: null, errors };
  }
  let imageLine: string | null = null;
  for (const line of rawAnswer.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push('logic_diagram raw_answer line missing "key=value" separator.');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === 'image') {
      imageLine = value;
    } else {
      errors.push(`logic_diagram raw_answer has unknown key '${key}'.`);
    }
  }
  if (imageLine === null) {
    return { image: null, errors };
  }
  if (imageLine.length > MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH) {
    errors.push(
      `logic_diagram image exceeds ${MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH} characters; rejected.`,
    );
    return { image: null, errors };
  }
  if (!imageLine.startsWith(LOGIC_DIAGRAM_DATA_URL_PREFIX)) {
    errors.push(`logic_diagram image must start with '${LOGIC_DIAGRAM_DATA_URL_PREFIX}'.`);
    return { image: null, errors };
  }
  const payload = imageLine.slice(LOGIC_DIAGRAM_DATA_URL_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    errors.push('logic_diagram image base64 payload is malformed.');
    return { image: null, errors };
  }
  return { image: imageLine, errors };
}

/**
 * Emits the canonical raw_answer string for a logic-diagram answer.
 * `null` → empty string ("not attempted").
 */
export function serialiseLogicDiagramAnswer(image: string | null): string {
  if (image === null || image.length === 0) return '';
  return `image=${image}`;
}

// ---------- gate_in_box variant raw_answer ----------

/**
 * Parses the line-encoded raw_answer into a Map keyed by gate id. Last
 * value wins if an id is repeated; malformed lines are ignored.
 */
export function parseLogicDiagramGatesRawAnswer(rawAnswer: string): Map<string, string> {
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

/** Emits `id=value` lines in gate order, skipping prefilled/empty blanks. */
export function serialiseLogicDiagramGatesAnswer(
  config: LogicDiagramGateInBoxConfig,
  pupilFills: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const g of config.gates) {
    if (!isLogicGateBlank(g)) continue;
    const v = pupilFills.get(g.id);
    if (v === undefined || v.length === 0) continue;
    lines.push(`${g.id}=${v}`);
  }
  return lines.join('\n');
}

// ---------- gate_in_box variant marking ----------

function normaliseGateAnswer(value: string, g: LogicGateBlank): string {
  let v = value;
  if (g.trimWhitespace !== false) v = v.trim();
  if (g.caseSensitive !== true) v = v.toLowerCase();
  return v;
}

export interface LogicGateOutcome {
  gateId: string;
  pupilValue: string | null;
  hit: boolean;
}

export interface LogicDiagramGatesMarkResult {
  outcomes: LogicGateOutcome[];
  hits: number;
  total: number;
}

/**
 * Marks a pupil answer against a gate_in_box config. One mark per blank
 * the pupil filled correctly; prefilled gates are ignored.
 */
export function markLogicDiagramGates(
  config: LogicDiagramGateInBoxConfig,
  pupilFills: ReadonlyMap<string, string>,
): LogicDiagramGatesMarkResult {
  const outcomes: LogicGateOutcome[] = [];
  let hits = 0;
  let total = 0;
  for (const g of config.gates) {
    if (!isLogicGateBlank(g)) continue;
    total += 1;
    const raw = pupilFills.get(g.id);
    if (raw === undefined || raw.length === 0) {
      outcomes.push({ gateId: g.id, pupilValue: null, hit: false });
      continue;
    }
    const normPupil = normaliseGateAnswer(raw, g);
    const hit = g.accept.some((a) => normaliseGateAnswer(a, g) === normPupil);
    if (hit) hits += 1;
    outcomes.push({ gateId: g.id, pupilValue: raw, hit });
  }
  return { outcomes, hits, total };
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('logic_diagram')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'logic_diagram'.");
  }
}
