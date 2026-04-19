// Per-widget config parsers for step 5 of the question-creation wizard.
//
// Each parser reads a flat form body (everything is a string), turns it into
// the JSON shape the widget registry expects in `part_config`, and finally
// passes the result through `validatePartConfig` as a belt-and-braces check
// so structural mistakes (mismatched row/correctByRow lengths, gaps that
// don't appear in the cloze text, etc.) surface as field-level issues rather
// than 500s on publish.
//
// Field-name conventions are kept boring on purpose so the templates stay
// readable: newline-separated lists land in a single textarea, matrix cells
// use `correct_<rowIndex>` (single) / `correct_<rowIndex>` newline-block
// (multi), trace cells use `prefill` / `expected` textareas where each line
// is `r,c=value`, cloze gaps use `id|alt1,alt2,…`, hotspots use
// `id|x|y|w|h|accept1,accept2,…`. The whole point of the wizard is that the
// teacher never has to know about JSONB, so the form fields are flat.
//
// Widgets that don't accept a part_config (multiple_choice, short_text,
// medium_text, extended_response, code, algorithm) get a no-op parser that
// returns `{ part_config: null }` and an empty editor partial — the step
// still exists so the wizard's nine-step shape is consistent.

import type { StepIssue } from './wizard-steps.js';
import { getWidget, validatePartConfig } from './widgets.js';

export interface DerivedMarkPoint {
  text: string;
  marks: number;
}

export interface WidgetConfigParseResult {
  ok: boolean;
  /** The parsed part_config to merge onto parts[0]. */
  config?: unknown;
  /**
   * Mark points derived from the editor's input (e.g. multiple_choice's
   * "tick the correct option(s)"). When present, parseStep4 writes these
   * onto parts[0].mark_points and step 6 hides the manual textarea.
   */
  derivedMarkPoints?: DerivedMarkPoint[];
  issues: StepIssue[];
}

type WidgetConfigParser = (body: Record<string, unknown>) => WidgetConfigParseResult;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function trimmed(v: unknown): string {
  return str(v).trim();
}

function lines(v: unknown): string[] {
  return str(v)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function intIn(v: unknown, min: number, max: number): number | null {
  const raw = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(raw)) return null;
  if (raw < min || raw > max) return null;
  return raw;
}

function noopParser(): WidgetConfigParseResult {
  return { ok: true, config: null, issues: [] };
}

// ---------------------------------------------------------------------------
// multiple_choice
// ---------------------------------------------------------------------------

function parseMultipleChoice(body: Record<string, unknown>): WidgetConfigParseResult {
  const options = lines(body['options']);
  const issues: StepIssue[] = [];

  if (options.length < 2) {
    issues.push({ path: 'options', message: 'List at least two options, one per line.' });
  }
  if (new Set(options).size !== options.length) {
    issues.push({ path: 'options', message: 'Each option must be unique.' });
  }

  // Field convention: correct_<i> = 'on' for each correct option (by index
  // into the parsed options array). Storing the index keeps the field name
  // simple even when option labels contain spaces or punctuation.
  const correct: string[] = [];
  for (let i = 0; i < options.length; i++) {
    if (trimmed(body[`correct_${i}`]) === 'on') correct.push(options[i]!);
  }
  if (options.length >= 2 && correct.length === 0) {
    issues.push({
      path: 'correct',
      message: 'Tick at least one option as the correct answer.',
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: { options },
    derivedMarkPoints: correct.map((text) => ({ text, marks: 1 })),
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// tick_box
// ---------------------------------------------------------------------------

function parseTickBox(body: Record<string, unknown>): WidgetConfigParseResult {
  const options = lines(body['options']);
  const tickExactlyRaw = trimmed(body['tickExactly']);
  const issues: StepIssue[] = [];

  if (options.length === 0) {
    issues.push({ path: 'options', message: 'List at least one option, one per line.' });
  }
  if (new Set(options).size !== options.length) {
    issues.push({ path: 'options', message: 'Each option must be unique.' });
  }
  let tickExactly: number | null = null;
  if (tickExactlyRaw.length > 0) {
    const n = intIn(tickExactlyRaw, 1, options.length || 1);
    if (n === null) {
      issues.push({
        path: 'tickExactly',
        message: 'Tick-exactly must be a positive integer no greater than the option count.',
      });
    } else {
      tickExactly = n;
    }
  }

  // Field convention: correct_<i> = 'on' for each option that should be
  // ticked. Mark_points are derived from this, so the teacher doesn't have
  // to retype them on step 6.
  const correct: string[] = [];
  for (let i = 0; i < options.length; i++) {
    if (trimmed(body[`correct_${i}`]) === 'on') correct.push(options[i]!);
  }
  if (options.length > 0 && correct.length === 0) {
    issues.push({
      path: 'correct',
      message: 'Tick at least one option as a correct answer.',
    });
  }
  if (tickExactly !== null && correct.length !== tickExactly) {
    issues.push({
      path: 'correct',
      message: `Tick exactly ${tickExactly} option(s) — you ticked ${correct.length}.`,
    });
  }

  const config: Record<string, unknown> = { options };
  if (tickExactly !== null) config['tickExactly'] = tickExactly;
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config,
    derivedMarkPoints: correct.map((text) => ({ text, marks: 1 })),
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// matrix_tick_single
// ---------------------------------------------------------------------------

function parseMatrixSingle(body: Record<string, unknown>): WidgetConfigParseResult {
  const rows = lines(body['rows']);
  const columns = lines(body['columns']);
  const issues: StepIssue[] = [];
  if (rows.length === 0)
    issues.push({ path: 'rows', message: 'List at least one row, one per line.' });
  if (columns.length < 2)
    issues.push({ path: 'columns', message: 'List at least two columns, one per line.' });

  const correctByRow: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const pick = trimmed(body[`correct_${i}`]);
    if (pick.length === 0) {
      issues.push({
        path: `correct_${i}`,
        message: `Row ${i + 1}: pick the correct column.`,
      });
      correctByRow.push('');
      continue;
    }
    if (columns.length > 0 && !columns.includes(pick)) {
      issues.push({
        path: `correct_${i}`,
        message: `Row ${i + 1}: '${pick}' is not one of the columns.`,
      });
    }
    correctByRow.push(pick);
  }

  const allOrNothing = trimmed(body['allOrNothing']) === 'on';
  const config = { rows, columns, correctByRow, allOrNothing };
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config, issues: [] };
}

// ---------------------------------------------------------------------------
// matrix_tick_multi
// ---------------------------------------------------------------------------

function parseMatrixMulti(body: Record<string, unknown>): WidgetConfigParseResult {
  const rows = lines(body['rows']);
  const columns = lines(body['columns']);
  const issues: StepIssue[] = [];
  if (rows.length === 0)
    issues.push({ path: 'rows', message: 'List at least one row, one per line.' });
  if (columns.length < 2)
    issues.push({ path: 'columns', message: 'List at least two columns, one per line.' });

  // Field convention: cell_<row>_<colIdx> = 'on' for each ticked cell. Storing
  // the column index (rather than the column name) keeps the input names
  // simple even when column labels contain spaces or punctuation.
  const correctByRow: string[][] = [];
  for (let i = 0; i < rows.length; i++) {
    const picks: string[] = [];
    for (let j = 0; j < columns.length; j++) {
      if (trimmed(body[`cell_${i}_${j}`]) === 'on') picks.push(columns[j]!);
    }
    correctByRow.push(picks);
  }

  const partialCredit = trimmed(body['partialCredit']) === 'on';
  const config = { rows, columns, correctByRow, partialCredit };
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config, issues: [] };
}

// ---------------------------------------------------------------------------
// trace_table
// ---------------------------------------------------------------------------

function parseTraceTable(body: Record<string, unknown>): WidgetConfigParseResult {
  const colNames = lines(body['columns']);
  const rowsCount = intIn(body['rows'], 1, 50);
  const issues: StepIssue[] = [];
  if (colNames.length === 0)
    issues.push({ path: 'columns', message: 'List at least one column, one per line.' });
  if (rowsCount === null)
    issues.push({ path: 'rows', message: 'Rows must be an integer between 1 and 50.' });

  const modeRaw = trimmed(body['mode']);
  const mode = modeRaw === 'perRow' || modeRaw === 'allOrNothing' ? modeRaw : 'perCell';

  // Field convention: a per-cell `mode_<r>_<c>` select (prefill/expected/decorative)
  // plus a `value_<r>_<c>` text input. The template renders them as a real
  // editable grid; this parser walks the rectangle defined by colNames × rowsCount.
  const prefill: Record<string, string> = {};
  const expected: Record<string, string> = {};
  if (rowsCount !== null && colNames.length > 0) {
    for (let r = 0; r < rowsCount; r++) {
      for (let c = 0; c < colNames.length; c++) {
        const cellMode = trimmed(body[`mode_${r}_${c}`]);
        const value = trimmed(body[`value_${r}_${c}`]);
        if (cellMode === 'prefill') {
          if (value.length === 0) {
            issues.push({
              path: `value_${r}_${c}`,
              message: `Pre-filled cell at row ${r + 1}, ${colNames[c]} needs a value.`,
            });
          } else {
            prefill[`${r},${c}`] = value;
          }
        } else if (cellMode === 'expected') {
          if (value.length === 0) {
            issues.push({
              path: `value_${r}_${c}`,
              message: `Expected cell at row ${r + 1}, ${colNames[c]} needs a value.`,
            });
          } else {
            expected[`${r},${c}`] = value;
          }
        }
        // decorative or empty mode: ignore the cell
      }
    }
  }

  if (Object.keys(expected).length === 0)
    issues.push({
      path: 'expected',
      message: 'Mark at least one cell as Expected so the pupil has something to fill in.',
    });

  const config = {
    columns: colNames.map((name) => ({ name })),
    rows: rowsCount ?? 1,
    prefill,
    expected,
    marking: { mode },
  };
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config, issues: [] };
}

// ---------------------------------------------------------------------------
// cloze (free / with_bank / code)
// ---------------------------------------------------------------------------

function parseGapsBlock(block: string, issues: StepIssue[]): { id: string; accept: string[] }[] {
  const gaps: { id: string; accept: string[] }[] = [];
  const seen = new Set<string>();
  for (const line of lines(block)) {
    const bar = line.indexOf('|');
    if (bar < 1) {
      issues.push({
        path: 'gaps',
        message: `Gap line '${line}' must look like "id|answer1,answer2".`,
      });
      continue;
    }
    const id = line.slice(0, bar).trim();
    const acceptRaw = line.slice(bar + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      issues.push({ path: 'gaps', message: `Gap id '${id}' must use letters, digits, _ or -.` });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ path: 'gaps', message: `Duplicate gap id '${id}'.` });
      continue;
    }
    seen.add(id);
    const accept = acceptRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (accept.length === 0) {
      issues.push({ path: 'gaps', message: `Gap '${id}' needs at least one accepted answer.` });
      continue;
    }
    gaps.push({ id, accept });
  }
  return gaps;
}

function buildClozeParser(opts: { requireBank: boolean }): WidgetConfigParser {
  return (body) => {
    const text = str(body['text']);
    const issues: StepIssue[] = [];
    if (text.trim().length === 0)
      issues.push({ path: 'text', message: 'The cloze passage is required.' });
    const gaps = parseGapsBlock(str(body['gaps']), issues);
    if (gaps.length === 0) issues.push({ path: 'gaps', message: 'List at least one gap.' });

    // Cross-check: every gap id must appear as {{id}} in text, in document order.
    const referenced: string[] = [];
    const re = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) referenced.push(m[1]!);
    const refSet = new Set(referenced);
    for (const g of gaps) {
      if (!refSet.has(g.id))
        issues.push({
          path: 'gaps',
          message: `Gap '${g.id}' is not referenced in the passage as {{${g.id}}}.`,
        });
    }

    const bank = lines(body['bank']);
    if (opts.requireBank && bank.length === 0)
      issues.push({ path: 'bank', message: 'List at least one bank entry, one per line.' });
    if (opts.requireBank && new Set(bank).size !== bank.length)
      issues.push({ path: 'bank', message: 'Bank entries must be unique.' });

    const config: Record<string, unknown> = { text, gaps };
    if (opts.requireBank || bank.length > 0) config['bank'] = bank;

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, config, issues: [] };
  };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

function parseMatching(body: Record<string, unknown>): WidgetConfigParseResult {
  const left = lines(body['left']);
  const right = lines(body['right']);
  const issues: StepIssue[] = [];
  if (left.length === 0)
    issues.push({ path: 'left', message: 'List at least one prompt, one per line.' });
  if (right.length === 0)
    issues.push({ path: 'right', message: 'List at least one option, one per line.' });
  if (new Set(left).size !== left.length)
    issues.push({ path: 'left', message: 'Each prompt must be unique.' });
  if (new Set(right).size !== right.length)
    issues.push({ path: 'right', message: 'Each option must be unique.' });

  const correctPairs: [number, number][] = [];
  for (let i = 0; i < left.length; i++) {
    const pickRaw = trimmed(body[`right_for_${i}`]);
    if (pickRaw.length === 0) {
      issues.push({ path: `right_for_${i}`, message: `Prompt ${i + 1}: pick a matching option.` });
      continue;
    }
    const idx = intIn(pickRaw, 0, Math.max(right.length - 1, 0));
    if (idx === null) {
      issues.push({
        path: `right_for_${i}`,
        message: `Prompt ${i + 1}: pick a valid option.`,
      });
      continue;
    }
    correctPairs.push([i, idx]);
  }

  const partialCredit = trimmed(body['partialCredit']) === 'on';
  const config = { left, right, correctPairs, partialCredit };
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config, issues: [] };
}

// ---------------------------------------------------------------------------
// logic_diagram, flowchart (canvas only)
// ---------------------------------------------------------------------------

function buildCanvasParser(): WidgetConfigParser {
  return (body) => {
    const width = intIn(body['canvas_width'], 100, 2000);
    const height = intIn(body['canvas_height'], 100, 2000);
    const issues: StepIssue[] = [];
    if (width === null)
      issues.push({ path: 'canvas_width', message: 'Canvas width must be 100–2000.' });
    if (height === null)
      issues.push({ path: 'canvas_height', message: 'Canvas height must be 100–2000.' });
    if (issues.length > 0) return { ok: false, issues };
    return {
      ok: true,
      config: { variant: 'image', canvas: { width: width!, height: height! } },
      issues: [],
    };
  };
}

// ---------------------------------------------------------------------------
// diagram_labels
// ---------------------------------------------------------------------------

function parseDiagramLabels(body: Record<string, unknown>): WidgetConfigParseResult {
  const imageUrl = trimmed(body['imageUrl']);
  const imageAlt = trimmed(body['imageAlt']);
  const width = intIn(body['width'], 50, 4000);
  const height = intIn(body['height'], 50, 4000);
  const issues: StepIssue[] = [];

  if (imageUrl.length === 0) issues.push({ path: 'imageUrl', message: 'Image URL is required.' });
  else if (!/^(\/static\/|https:\/\/)/.test(imageUrl))
    issues.push({ path: 'imageUrl', message: 'Image URL must start with /static/ or https://.' });
  if (imageAlt.length === 0)
    issues.push({ path: 'imageAlt', message: 'Image alt text is required for screen readers.' });
  if (width === null) issues.push({ path: 'width', message: 'Image width must be 50–4000 px.' });
  if (height === null) issues.push({ path: 'height', message: 'Image height must be 50–4000 px.' });

  const hotspots: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    accept: string[];
  }[] = [];
  const seen = new Set<string>();
  for (const line of lines(body['hotspots'])) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 6) {
      issues.push({
        path: 'hotspots',
        message: `Hotspot line '${line}' must look like "id|x|y|width|height|accept1,accept2".`,
      });
      continue;
    }
    const [id, xs, ys, ws, hs, acceptRaw] = parts;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id!)) {
      issues.push({
        path: 'hotspots',
        message: `Hotspot id '${id}' must be 1-40 chars (letters, digits, _ or -).`,
      });
      continue;
    }
    if (seen.has(id!)) {
      issues.push({ path: 'hotspots', message: `Duplicate hotspot id '${id}'.` });
      continue;
    }
    seen.add(id!);
    const x = intIn(xs, 0, 4000);
    const y = intIn(ys, 0, 4000);
    const w = intIn(ws, 20, 4000);
    const h = intIn(hs, 20, 4000);
    if (x === null || y === null || w === null || h === null) {
      issues.push({
        path: 'hotspots',
        message: `Hotspot '${id}': x and y must be ≥0; width and height must be ≥20.`,
      });
      continue;
    }
    const accept = (acceptRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (accept.length === 0) {
      issues.push({
        path: 'hotspots',
        message: `Hotspot '${id}' needs at least one accepted answer.`,
      });
      continue;
    }
    hotspots.push({ id: id!, x, y, width: w, height: h, accept });
  }

  if (hotspots.length === 0)
    issues.push({ path: 'hotspots', message: 'List at least one hotspot.' });

  const config = {
    imageUrl,
    imageAlt,
    width: width ?? 50,
    height: height ?? 50,
    hotspots,
  };
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config, issues: [] };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const PARSERS: Readonly<Record<string, WidgetConfigParser>> = {
  multiple_choice: parseMultipleChoice,
  short_text: noopParser,
  medium_text: noopParser,
  extended_response: noopParser,
  code: noopParser,
  algorithm: noopParser,
  tick_box: parseTickBox,
  matrix_tick_single: parseMatrixSingle,
  matrix_tick_multi: parseMatrixMulti,
  trace_table: parseTraceTable,
  cloze_free: buildClozeParser({ requireBank: false }),
  cloze_code: buildClozeParser({ requireBank: false }),
  cloze_with_bank: buildClozeParser({ requireBank: true }),
  matching: parseMatching,
  logic_diagram: buildCanvasParser(),
  flowchart: buildCanvasParser(),
  diagram_labels: parseDiagramLabels,
};

export function widgetEditorIsNoop(widgetType: string): boolean {
  return PARSERS[widgetType] === noopParser;
}

/**
 * Widgets whose step-4 editor produces the part's mark_points as a
 * by-product (currently: multiple_choice, where ticking "correct" on each
 * option is the mark_point input). Step 6 hides the manual mark_points
 * textarea for these widgets.
 */
const AUTO_DERIVES_MARK_POINTS = new Set<string>(['multiple_choice', 'tick_box']);

export function widgetAutoDerivesMarkPoints(widgetType: string): boolean {
  return AUTO_DERIVES_MARK_POINTS.has(widgetType);
}

export function parseWidgetConfig(widgetType: string, body: unknown): WidgetConfigParseResult {
  const reg = getWidget(widgetType);
  if (!reg) {
    return {
      ok: false,
      issues: [{ path: 'expected_response_type', message: `Unknown widget type '${widgetType}'.` }],
    };
  }
  const parser = PARSERS[widgetType];
  if (!parser) {
    return {
      ok: false,
      issues: [
        {
          path: 'expected_response_type',
          message: `No editor wired for widget '${widgetType}' (this is a bug).`,
        },
      ],
    };
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const result = parser(record);
  if (!result.ok) return result;

  // Belt-and-braces: run the registry's own validator over the produced
  // config so cross-field invariants (correctByRow length matches rows
  // length, gap ids referenced in cloze.text appear in cloze.gaps, etc.)
  // surface as field-level issues instead of 500s on publish.
  const registryIssues = validatePartConfig(widgetType, result.config);
  if (registryIssues.length > 0) {
    return {
      ok: false,
      issues: registryIssues.map((i) => ({ path: '_', message: i.message })),
    };
  }
  return result;
}
