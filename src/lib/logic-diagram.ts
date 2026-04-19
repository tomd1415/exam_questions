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

export type LogicDiagramVariant =
  | 'image'
  | 'gate_in_box'
  | 'guided_slots'
  | 'boolean_expression'
  | 'gate_palette';

export const SUPPORTED_LOGIC_DIAGRAM_VARIANTS: readonly LogicDiagramVariant[] = [
  'image',
  'gate_in_box',
  'guided_slots',
  'boolean_expression',
  'gate_palette',
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

// ---- guided_slots ----------------------------------------------------------

export interface LogicGuidedSlot {
  id: string;
  /** Short prompt shown next to the slot's control. */
  prompt: string;
  /** The fixed option pool presented to the pupil. */
  options: readonly string[];
  /** Which option is correct (must appear in `options`). */
  accept: string;
}

export interface LogicDiagramGuidedSlotsConfig {
  variant: 'guided_slots';
  slots: readonly LogicGuidedSlot[];
}

// ---- boolean_expression ----------------------------------------------------

export type LogicBooleanOperator = 'AND' | 'OR' | 'NOT' | 'XOR';

export const LOGIC_BOOLEAN_OPERATORS: readonly LogicBooleanOperator[] = ['AND', 'OR', 'NOT', 'XOR'];

export interface LogicDiagramBooleanExpressionConfig {
  variant: 'boolean_expression';
  /** One or more canonical forms of the expected expression. */
  accept: readonly string[];
  /** Limits the token palette the pupil sees; defaults to AND/OR/NOT. */
  allowedOperators?: readonly LogicBooleanOperator[];
  /** Default false: inputs are uppercased before comparison. */
  caseSensitive?: boolean;
  /** Default true: `.` → AND, `+` → OR, `/X` / `~X` → NOT X, `⊕` → XOR. */
  normaliseSymbols?: boolean;
}

// ---- gate_palette ----------------------------------------------------------

export interface LogicTruthTableRow {
  /** Input name → 0 or 1, e.g. `{ A: 0, B: 1, C: 1 }`. */
  inputs: Readonly<Record<string, 0 | 1>>;
  /** Expected output value. */
  output: 0 | 1;
}

export interface LogicDiagramGatePaletteConfig {
  variant: 'gate_palette';
  canvas: { width: number; height: number };
  /** Pre-placed terminals (ids reused when marking the pupil's circuit). */
  terminals: readonly LogicTerminal[];
  /** Which gate types the pupil may drag onto the canvas. */
  palette: readonly LogicGateType[];
  /** Optional cap on gate count (defaults to 8). */
  maxGates?: number;
  /** Truth table the pupil's circuit must satisfy. Covers every input row. */
  expected: { truthTable: readonly LogicTruthTableRow[] };
}

export type LogicDiagramConfig =
  | LogicDiagramImageConfig
  | LogicDiagramGateInBoxConfig
  | LogicDiagramGuidedSlotsConfig
  | LogicDiagramBooleanExpressionConfig
  | LogicDiagramGatePaletteConfig;

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

  const isNonNegInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0;

  if (variant === 'image') {
    isCanvas(cfg['canvas'], 'logic_diagram', issues);
    for (const key of Object.keys(cfg)) {
      if (key !== 'variant' && key !== 'canvas') {
        issues.push(`logic_diagram has unsupported key '${key}' for the 'image' variant.`);
      }
    }
    return issues;
  }

  if (variant === 'guided_slots') {
    validateGuidedSlots(cfg, issues);
    for (const key of Object.keys(cfg)) {
      if (key !== 'variant' && key !== 'slots') {
        issues.push(`logic_diagram has unsupported key '${key}' for the 'guided_slots' variant.`);
      }
    }
    return issues;
  }

  if (variant === 'boolean_expression') {
    validateBooleanExpression(cfg, issues);
    for (const key of Object.keys(cfg)) {
      if (
        key !== 'variant' &&
        key !== 'accept' &&
        key !== 'allowedOperators' &&
        key !== 'caseSensitive' &&
        key !== 'normaliseSymbols'
      ) {
        issues.push(
          `logic_diagram has unsupported key '${key}' for the 'boolean_expression' variant.`,
        );
      }
    }
    return issues;
  }

  if (variant === 'gate_palette') {
    const { w: canvasW, h: canvasH } = isCanvas(cfg['canvas'], 'logic_diagram', issues);
    validateGatePalette(cfg, canvasW, canvasH, isNonNegInt, issues);
    for (const key of Object.keys(cfg)) {
      if (
        key !== 'variant' &&
        key !== 'canvas' &&
        key !== 'terminals' &&
        key !== 'palette' &&
        key !== 'maxGates' &&
        key !== 'expected'
      ) {
        issues.push(`logic_diagram has unsupported key '${key}' for the 'gate_palette' variant.`);
      }
    }
    return issues;
  }

  // variant === 'gate_in_box'
  const { w: canvasW, h: canvasH } = isCanvas(cfg['canvas'], 'logic_diagram', issues);
  const gates = cfg['gates'];
  const terminals = cfg['terminals'];
  const wires = cfg['wires'];

  const seenIds = new Set<string>();
  let blankCount = 0;

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

// ---------- guided_slots validator ----------

function validateGuidedSlots(cfg: Record<string, unknown>, issues: string[]): void {
  const slots = cfg['slots'];
  if (!Array.isArray(slots) || slots.length === 0) {
    issues.push('logic_diagram.slots must be a non-empty array.');
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < slots.length; i += 1) {
    const raw: unknown = slots[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`logic_diagram.slots[${i}] must be an object.`);
      continue;
    }
    const s = raw as Record<string, unknown>;
    const id = s['id'];
    const prompt = s['prompt'];
    const options = s['options'];
    const accept = s['accept'];

    if (typeof id !== 'string' || !ID_RE.test(id)) {
      issues.push(`logic_diagram.slots[${i}].id must match ${ID_RE.source}.`);
    } else if (seen.has(id)) {
      issues.push(`logic_diagram.slots reuses id '${id}'.`);
    } else {
      seen.add(id);
    }
    if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 200) {
      issues.push(`logic_diagram.slots[${i}].prompt must be a 1–200 character string.`);
    }
    if (!Array.isArray(options) || options.length < 2) {
      issues.push(`logic_diagram.slots[${i}].options must list at least two options.`);
    } else if (!options.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 40)) {
      issues.push(`logic_diagram.slots[${i}].options entries must be 1–40 character strings.`);
    } else if (new Set(options).size !== options.length) {
      issues.push(`logic_diagram.slots[${i}].options entries must be unique.`);
    } else if (typeof accept !== 'string' || !options.includes(accept)) {
      issues.push(`logic_diagram.slots[${i}].accept must be one of the slot's options.`);
    }
    for (const key of Object.keys(s)) {
      if (key !== 'id' && key !== 'prompt' && key !== 'options' && key !== 'accept') {
        issues.push(`logic_diagram.slots[${i}] has unsupported key '${key}'.`);
      }
    }
  }
}

// ---------- boolean_expression validator ----------

function validateBooleanExpression(cfg: Record<string, unknown>, issues: string[]): void {
  const accept = cfg['accept'];
  const allowedOperators = cfg['allowedOperators'];
  const caseSensitive = cfg['caseSensitive'];
  const normaliseSymbols = cfg['normaliseSymbols'];

  if (!Array.isArray(accept) || accept.length === 0) {
    issues.push('logic_diagram.accept must be a non-empty array of expected expressions.');
  } else if (
    !accept.every((v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200)
  ) {
    issues.push('logic_diagram.accept entries must be 1–200 character non-empty strings.');
  }
  if (allowedOperators !== undefined) {
    if (!Array.isArray(allowedOperators) || allowedOperators.length === 0) {
      issues.push('logic_diagram.allowedOperators must be a non-empty array if present.');
    } else if (
      !allowedOperators.every(
        (v) => typeof v === 'string' && LOGIC_BOOLEAN_OPERATORS.includes(v as LogicBooleanOperator),
      )
    ) {
      issues.push(
        `logic_diagram.allowedOperators entries must each be one of: ${LOGIC_BOOLEAN_OPERATORS.join(', ')}.`,
      );
    }
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    issues.push('logic_diagram.caseSensitive must be a boolean if present.');
  }
  if (normaliseSymbols !== undefined && typeof normaliseSymbols !== 'boolean') {
    issues.push('logic_diagram.normaliseSymbols must be a boolean if present.');
  }
}

// ---------- gate_palette validator ----------

function validateGatePalette(
  cfg: Record<string, unknown>,
  canvasW: number,
  canvasH: number,
  isNonNegInt: (v: unknown) => v is number,
  issues: string[],
): void {
  const terminals = cfg['terminals'];
  const palette = cfg['palette'];
  const maxGates = cfg['maxGates'];
  const expected = cfg['expected'];

  const inputIds = new Set<string>();
  const outputIds = new Set<string>();
  const seenIds = new Set<string>();

  if (!Array.isArray(terminals) || terminals.length === 0) {
    issues.push('logic_diagram.terminals must be a non-empty array.');
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
        issues.push(`logic_diagram.terminals reuses id '${id}'.`);
      } else {
        seenIds.add(id);
        if (kind === 'input') inputIds.add(id);
        else if (kind === 'output') outputIds.add(id);
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
  if (inputIds.size === 0) {
    issues.push('logic_diagram.terminals must include at least one input terminal.');
  }
  if (outputIds.size !== 1) {
    issues.push('logic_diagram.terminals must include exactly one output terminal.');
  }

  if (!Array.isArray(palette) || palette.length === 0) {
    issues.push(
      `logic_diagram.palette must be a non-empty array of: ${LOGIC_GATE_TYPES.join(', ')}.`,
    );
  } else if (
    !palette.every((v) => typeof v === 'string' && LOGIC_GATE_TYPES.includes(v as LogicGateType))
  ) {
    issues.push(
      `logic_diagram.palette entries must each be one of: ${LOGIC_GATE_TYPES.join(', ')}.`,
    );
  } else if (new Set(palette).size !== palette.length) {
    issues.push('logic_diagram.palette entries must be unique.');
  }

  if (maxGates !== undefined) {
    if (
      typeof maxGates !== 'number' ||
      !Number.isInteger(maxGates) ||
      maxGates < 1 ||
      maxGates > 20
    ) {
      issues.push('logic_diagram.maxGates must be an integer between 1 and 20 if present.');
    }
  }

  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    issues.push("logic_diagram.expected must be an object with a 'truthTable' array.");
    return;
  }
  const exp = expected as Record<string, unknown>;
  const truthTable = exp['truthTable'];
  for (const key of Object.keys(exp)) {
    if (key !== 'truthTable') {
      issues.push(`logic_diagram.expected has unsupported key '${key}'.`);
    }
  }
  if (!Array.isArray(truthTable) || truthTable.length === 0) {
    issues.push('logic_diagram.expected.truthTable must be a non-empty array of rows.');
    return;
  }
  const expectedCoverage = 1 << inputIds.size;
  if (inputIds.size > 0 && truthTable.length !== expectedCoverage) {
    issues.push(
      `logic_diagram.expected.truthTable must cover all ${expectedCoverage} input combinations (got ${truthTable.length}).`,
    );
  }
  for (let i = 0; i < truthTable.length; i += 1) {
    const row: unknown = truthTable[i];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      issues.push(`logic_diagram.expected.truthTable[${i}] must be an object.`);
      continue;
    }
    const r = row as Record<string, unknown>;
    const inputs = r['inputs'];
    const output = r['output'];
    if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
      issues.push(`logic_diagram.expected.truthTable[${i}].inputs must be an object.`);
    } else {
      const ins = inputs as Record<string, unknown>;
      for (const id of inputIds) {
        const v = ins[id];
        if (v !== 0 && v !== 1) {
          issues.push(`logic_diagram.expected.truthTable[${i}].inputs['${id}'] must be 0 or 1.`);
        }
      }
      for (const key of Object.keys(ins)) {
        if (!inputIds.has(key)) {
          issues.push(`logic_diagram.expected.truthTable[${i}].inputs has unknown key '${key}'.`);
        }
      }
    }
    if (output !== 0 && output !== 1) {
      issues.push(`logic_diagram.expected.truthTable[${i}].output must be 0 or 1.`);
    }
    for (const key of Object.keys(r)) {
      if (key !== 'inputs' && key !== 'output') {
        issues.push(`logic_diagram.expected.truthTable[${i}] has unsupported key '${key}'.`);
      }
    }
  }
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

// ---------- guided_slots variant raw_answer + marking ----------

/**
 * Parses `slotId=value` lines. Shares the gate_in_box format since both
 * use ID-keyed scalar fills.
 */
export function parseLogicDiagramSlotsRawAnswer(rawAnswer: string): Map<string, string> {
  return parseLogicDiagramGatesRawAnswer(rawAnswer);
}

/** Emits `slotId=value` lines in config order, skipping empty answers. */
export function serialiseLogicDiagramSlotsAnswer(
  config: LogicDiagramGuidedSlotsConfig,
  pupilFills: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const s of config.slots) {
    const v = pupilFills.get(s.id);
    if (v === undefined || v.length === 0) continue;
    lines.push(`${s.id}=${v}`);
  }
  return lines.join('\n');
}

export interface LogicSlotOutcome {
  slotId: string;
  pupilValue: string | null;
  hit: boolean;
}

export interface LogicDiagramSlotsMarkResult {
  outcomes: LogicSlotOutcome[];
  hits: number;
  total: number;
}

/**
 * Marks pupil slot choices against the fixed option pool. Exact match
 * against `accept` (the option the teacher marked correct); one mark per
 * slot.
 */
export function markLogicDiagramSlots(
  config: LogicDiagramGuidedSlotsConfig,
  pupilFills: ReadonlyMap<string, string>,
): LogicDiagramSlotsMarkResult {
  const outcomes: LogicSlotOutcome[] = [];
  let hits = 0;
  for (const s of config.slots) {
    const raw = pupilFills.get(s.id);
    if (raw === undefined || raw.length === 0) {
      outcomes.push({ slotId: s.id, pupilValue: null, hit: false });
      continue;
    }
    const hit = raw === s.accept;
    if (hit) hits += 1;
    outcomes.push({ slotId: s.id, pupilValue: raw, hit });
  }
  return { outcomes, hits, total: config.slots.length };
}

// ---------- boolean_expression variant raw_answer + marking ----------

export interface ParsedLogicDiagramBooleanAnswer {
  expression: string | null;
  errors: string[];
}

/**
 * Parses `expression=<text>` from the line-encoded raw_answer. Any other
 * keys are rejected. The value is returned verbatim; marking normalises.
 */
export function parseLogicDiagramBooleanRawAnswer(
  rawAnswer: string,
): ParsedLogicDiagramBooleanAnswer {
  const errors: string[] = [];
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) {
    return { expression: null, errors };
  }
  let expression: string | null = null;
  for (const line of rawAnswer.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push('logic_diagram raw_answer line missing "key=value" separator.');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === 'expression') {
      expression = value;
    } else {
      errors.push(`logic_diagram raw_answer has unknown key '${key}'.`);
    }
  }
  return { expression, errors };
}

export function serialiseLogicDiagramBooleanAnswer(expression: string | null): string {
  if (expression === null || expression.length === 0) return '';
  return `expression=${expression}`;
}

/**
 * Tokenises a boolean expression into a canonical list. Symbols are
 * rewritten to keyword operators (`.` → AND, `+` → OR, `~`/`/` → NOT,
 * `⊕` → XOR), parentheses are kept as standalone tokens, identifiers
 * are uppercased, whitespace is discarded.
 *
 * This is deliberately a syntactic comparison — we do not attempt
 * algebraic equivalence. Teachers list every phrasing they'll accept.
 */
export function tokeniseBooleanExpression(
  expression: string,
  options: { caseSensitive?: boolean; normaliseSymbols?: boolean } = {},
): string[] {
  const caseSensitive = options.caseSensitive === true;
  const normaliseSymbols = options.normaliseSymbols !== false;
  const tokens: string[] = [];
  let i = 0;
  const src = expression;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (normaliseSymbols) {
      if (ch === '.' || ch === '∧' || ch === '&') {
        tokens.push('AND');
        i += 1;
        continue;
      }
      if (ch === '+' || ch === '∨' || ch === '|') {
        tokens.push('OR');
        i += 1;
        continue;
      }
      if (ch === '~' || ch === '¬' || ch === '!') {
        tokens.push('NOT');
        i += 1;
        continue;
      }
      if (ch === '⊕' || ch === '^') {
        tokens.push('XOR');
        i += 1;
        continue;
      }
      if (ch === '/') {
        // `/X` → NOT X. A bare `/` that isn't followed by an identifier
        // is just emitted as-is so we don't silently swallow odd input.
        const next = src[i + 1];
        if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
          tokens.push('NOT');
          i += 1;
          continue;
        }
      }
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      let word = src.slice(i, j);
      if (!caseSensitive) word = word.toUpperCase();
      tokens.push(word);
      i = j;
      continue;
    }
    // Unknown character — keep it so comparisons fail loudly rather
    // than silently normalising away a typo.
    tokens.push(ch);
    i += 1;
  }
  return tokens;
}

export interface LogicDiagramBooleanMarkResult {
  hit: boolean;
  matchedIndex: number | null;
  pupilTokens: string[];
}

/**
 * Marks a pupil expression against each `accept` entry. Tokens must match
 * exactly (order and value); one mark is awarded for any match.
 */
export function markLogicDiagramBooleanExpression(
  config: LogicDiagramBooleanExpressionConfig,
  pupilExpression: string | null,
): LogicDiagramBooleanMarkResult {
  if (pupilExpression === null || pupilExpression.length === 0) {
    return { hit: false, matchedIndex: null, pupilTokens: [] };
  }
  const opts: { caseSensitive?: boolean; normaliseSymbols?: boolean } = {};
  if (config.caseSensitive !== undefined) opts.caseSensitive = config.caseSensitive;
  if (config.normaliseSymbols !== undefined) opts.normaliseSymbols = config.normaliseSymbols;
  const pupilTokens = tokeniseBooleanExpression(pupilExpression, opts);
  for (let i = 0; i < config.accept.length; i += 1) {
    const expected = tokeniseBooleanExpression(config.accept[i]!, opts);
    if (expected.length !== pupilTokens.length) continue;
    let ok = true;
    for (let j = 0; j < expected.length; j += 1) {
      if (expected[j] !== pupilTokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return { hit: true, matchedIndex: i, pupilTokens };
  }
  return { hit: false, matchedIndex: null, pupilTokens };
}

// ---------- gate_palette variant raw_answer + marking ----------

export interface LogicPupilGate {
  id: string;
  type: LogicGateType;
}

export interface LogicPupilWire {
  from: string;
  to: string;
}

export interface LogicPupilCircuit {
  gates: LogicPupilGate[];
  wires: LogicPupilWire[];
}

export interface ParsedLogicDiagramPaletteAnswer {
  circuit: LogicPupilCircuit | null;
  errors: string[];
}

/**
 * Parses a single `circuit=<json>` line. The JSON payload shape is
 * `{ gates: [{id, type}], wires: [{from, to}] }`; anything else yields
 * `circuit: null` plus errors for the marker to report as "not
 * attempted / malformed".
 */
export function parseLogicDiagramPaletteRawAnswer(
  rawAnswer: string,
): ParsedLogicDiagramPaletteAnswer {
  const errors: string[] = [];
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) {
    return { circuit: null, errors };
  }
  let circuitJson: string | null = null;
  for (const line of rawAnswer.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push('logic_diagram raw_answer line missing "key=value" separator.');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === 'circuit') {
      circuitJson = value;
    } else {
      errors.push(`logic_diagram raw_answer has unknown key '${key}'.`);
    }
  }
  if (circuitJson === null) return { circuit: null, errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(circuitJson);
  } catch {
    errors.push('logic_diagram circuit payload is not valid JSON.');
    return { circuit: null, errors };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('logic_diagram circuit payload must be a JSON object.');
    return { circuit: null, errors };
  }
  const obj = parsed as Record<string, unknown>;
  const gatesRaw = obj['gates'];
  const wiresRaw = obj['wires'];
  if (!Array.isArray(gatesRaw) || !Array.isArray(wiresRaw)) {
    errors.push('logic_diagram circuit payload must contain gates[] and wires[].');
    return { circuit: null, errors };
  }
  const gates: LogicPupilGate[] = [];
  for (let i = 0; i < gatesRaw.length; i += 1) {
    const g: unknown = gatesRaw[i];
    if (g === null || typeof g !== 'object' || Array.isArray(g)) {
      errors.push(`logic_diagram circuit.gates[${i}] must be an object.`);
      continue;
    }
    const gr = g as Record<string, unknown>;
    const id = gr['id'];
    const type = gr['type'];
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push(`logic_diagram circuit.gates[${i}].id is missing or invalid.`);
      continue;
    }
    if (typeof type !== 'string' || !LOGIC_GATE_TYPES.includes(type as LogicGateType)) {
      errors.push(`logic_diagram circuit.gates[${i}].type must be one of AND/OR/NOT.`);
      continue;
    }
    gates.push({ id, type: type as LogicGateType });
  }
  const wires: LogicPupilWire[] = [];
  for (let i = 0; i < wiresRaw.length; i += 1) {
    const w: unknown = wiresRaw[i];
    if (w === null || typeof w !== 'object' || Array.isArray(w)) {
      errors.push(`logic_diagram circuit.wires[${i}] must be an object.`);
      continue;
    }
    const wr = w as Record<string, unknown>;
    const from = wr['from'];
    const to = wr['to'];
    if (typeof from !== 'string' || typeof to !== 'string') {
      errors.push(`logic_diagram circuit.wires[${i}] must have string from/to.`);
      continue;
    }
    wires.push({ from, to });
  }
  return { circuit: { gates, wires }, errors };
}

export function serialiseLogicDiagramPaletteAnswer(circuit: LogicPupilCircuit | null): string {
  if (circuit === null) return '';
  return `circuit=${JSON.stringify(circuit)}`;
}

/**
 * Evaluates the pupil circuit for a single input assignment. Returns
 * `null` if the circuit is malformed (cycle, missing driver, gate with
 * wrong fan-in, etc.) — the caller marks such attempts as wrong.
 */
function evaluatePupilCircuit(
  config: LogicDiagramGatePaletteConfig,
  circuit: LogicPupilCircuit,
  inputs: Readonly<Record<string, 0 | 1>>,
): 0 | 1 | null {
  const outputTerminal = config.terminals.find((t) => t.kind === 'output');
  if (outputTerminal === undefined) return null;

  const values = new Map<string, 0 | 1>();
  for (const t of config.terminals) {
    if (t.kind === 'input') {
      const v = inputs[t.id];
      if (v !== 0 && v !== 1) return null;
      values.set(t.id, v);
    }
  }

  // For each gate, collect incoming wire sources.
  const gateById = new Map<string, LogicPupilGate>();
  for (const g of circuit.gates) gateById.set(g.id, g);
  const incoming = new Map<string, string[]>();
  for (const g of circuit.gates) incoming.set(g.id, []);
  incoming.set(outputTerminal.id, []);
  for (const w of circuit.wires) {
    const bucket = incoming.get(w.to);
    if (bucket === undefined) return null;
    bucket.push(w.from);
  }

  // Resolve with DFS + memoisation; detect cycles.
  const resolving = new Set<string>();
  const resolve = (nodeId: string): 0 | 1 | null => {
    const cached = values.get(nodeId);
    if (cached !== undefined) return cached;
    if (resolving.has(nodeId)) return null;
    resolving.add(nodeId);
    const gate = gateById.get(nodeId);
    if (gate === undefined) {
      resolving.delete(nodeId);
      return null;
    }
    const sources = incoming.get(nodeId) ?? [];
    const inVals: (0 | 1)[] = [];
    for (const src of sources) {
      const v = resolve(src);
      if (v === null) {
        resolving.delete(nodeId);
        return null;
      }
      inVals.push(v);
    }
    let out: 0 | 1;
    if (gate.type === 'NOT') {
      if (inVals.length !== 1) {
        resolving.delete(nodeId);
        return null;
      }
      out = inVals[0] === 0 ? 1 : 0;
    } else if (gate.type === 'AND') {
      if (inVals.length < 2) {
        resolving.delete(nodeId);
        return null;
      }
      out = inVals.every((v) => v === 1) ? 1 : 0;
    } else {
      if (inVals.length < 2) {
        resolving.delete(nodeId);
        return null;
      }
      out = inVals.some((v) => v === 1) ? 1 : 0;
    }
    values.set(nodeId, out);
    resolving.delete(nodeId);
    return out;
  };

  const outSources = incoming.get(outputTerminal.id) ?? [];
  if (outSources.length !== 1) return null;
  return resolve(outSources[0]!);
}

export interface LogicDiagramPaletteRowOutcome {
  inputs: Readonly<Record<string, 0 | 1>>;
  expected: 0 | 1;
  actual: 0 | 1 | null;
  hit: boolean;
}

export interface LogicDiagramPaletteMarkResult {
  hit: boolean;
  rows: LogicDiagramPaletteRowOutcome[];
}

/**
 * Marks the pupil circuit by exhaustively evaluating it against the
 * expected truth table. Awarded iff every row matches.
 */
export function markLogicDiagramPalette(
  config: LogicDiagramGatePaletteConfig,
  circuit: LogicPupilCircuit | null,
): LogicDiagramPaletteMarkResult {
  if (circuit === null) {
    return {
      hit: false,
      rows: config.expected.truthTable.map((r) => ({
        inputs: r.inputs,
        expected: r.output,
        actual: null,
        hit: false,
      })),
    };
  }
  const rows: LogicDiagramPaletteRowOutcome[] = [];
  let allOk = true;
  for (const r of config.expected.truthTable) {
    const actual = evaluatePupilCircuit(config, circuit, r.inputs);
    const hit = actual === r.output;
    if (!hit) allOk = false;
    rows.push({ inputs: r.inputs, expected: r.output, actual, hit });
  }
  return { hit: allOk, rows };
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('logic_diagram')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'logic_diagram'.");
  }
}
