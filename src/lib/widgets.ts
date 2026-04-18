// Widget registry — single source of truth for response-type metadata.
//
// Each entry says how a part of that type is marked (deterministically by
// `markAttemptPart` or pending teacher review) and validates the shape of
// the optional `part_config` JSONB blob attached to the question_part row.
//
// 2.5a-i ships the registry covering the eight legacy types; every one
// requires `part_config` to be NULL/undefined. Later 2.5 chunks add new
// widget types whose configs are non-null (matrix grids, cloze gaps,
// truth/trace tables with prefilled cells, etc.).
//
// The dispatcher template `_paper_part_widget.eta` and the deterministic
// marker still branch on `expected_response_type` directly. The registry
// is what proves they stay in sync — see the exhaustiveness test in
// `tests/unit/widgets.test.ts`.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';
import { validateClozeConfigShape } from './cloze.js';
import { validateMatchingConfigShape } from './matching.js';
import { validateTraceGridConfigShape } from './trace-grid.js';

export type WidgetMarker = 'deterministic' | 'teacher_pending';

export interface PartConfigIssue {
  message: string;
}

/**
 * A subset of JSON Schema (Draft 2020-12) sufficient to describe every
 * widget's part_config shape. Kept as a structural alias rather than an
 * imported type so the registry has no runtime dependency on ajv — the
 * validator is only loaded by tests and by the schema generator script.
 */
export type WidgetConfigSchema = Record<string, unknown>;

export interface WidgetRegistration {
  /** Response-type code, must appear in EXPECTED_RESPONSE_TYPES. */
  type: string;
  /** Whether this widget can be marked without a teacher in the loop. */
  marker: WidgetMarker;
  /** Human label shown in the question wizard. */
  displayName: string;
  /** One-to-two sentence summary of what this question type asks of pupils. */
  description: string;
  /** One-line guidance the wizard shows when authoring mark_points for this widget. */
  markPointGuidance: string;
  /**
   * JSON Schema (Draft 2020-12) describing the shape of part_config.
   * `null` means the widget does not accept a part_config payload.
   */
  configSchema: WidgetConfigSchema | null;
  /**
   * A minimal example part_config that satisfies `configSchema` and
   * `validateConfig`. `null` for widgets that don't accept a config.
   */
  exampleConfig: unknown;
  /**
   * Validates the optional part_config payload. Returns issues for each
   * problem found; an empty array means the config is acceptable.
   * `null` and `undefined` are equivalent and mean "no config".
   */
  validateConfig(config: unknown): PartConfigIssue[];
}

function configMustBeNull(type: string): (config: unknown) => PartConfigIssue[] {
  return (config) => {
    if (config === null || config === undefined) return [];
    return [{ message: `Widget '${type}' does not accept a part_config payload.` }];
  };
}

// ---------------------------------------------------------------------------
// JSON Schema descriptors
//
// One per widget. These describe the *structural* shape of part_config
// that the wizard can rely on while authoring questions. Cross-field
// invariants (e.g. correctByRow length matches rows length, gap ids
// referenced in cloze.text appear in cloze.gaps) cannot be expressed
// in pure JSON Schema and remain the responsibility of `validateConfig`.
// The parity test in tests/unit/widgets-schema.test.ts proves the two
// agree on every fixture that the schema *can* judge.
// ---------------------------------------------------------------------------

const SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const TICK_BOX_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'tick_box part_config',
  type: 'object',
  additionalProperties: false,
  properties: {
    tickExactly: { type: 'integer', minimum: 1 },
    options: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
  },
};

const MATRIX_TICK_SINGLE_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'matrix_tick_single part_config',
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'columns', 'correctByRow'],
  properties: {
    rows: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    columns: { type: 'array', minItems: 2, items: { type: 'string', minLength: 1 } },
    correctByRow: { type: 'array', items: { type: 'string', minLength: 1 } },
    allOrNothing: { type: 'boolean' },
  },
};

const MATRIX_TICK_MULTI_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'matrix_tick_multi part_config',
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'columns', 'correctByRow'],
  properties: {
    rows: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    columns: { type: 'array', minItems: 2, items: { type: 'string', minLength: 1 } },
    correctByRow: {
      type: 'array',
      items: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
    },
    partialCredit: { type: 'boolean' },
  },
};

const CLOZE_GAP_SCHEMA: WidgetConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'accept'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
    accept: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    caseSensitive: { type: 'boolean' },
    trimWhitespace: { type: 'boolean' },
  },
};

const CLOZE_FREE_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'cloze_free part_config',
  type: 'object',
  additionalProperties: false,
  required: ['text', 'gaps'],
  properties: {
    text: { type: 'string', minLength: 1 },
    gaps: { type: 'array', minItems: 1, items: CLOZE_GAP_SCHEMA },
    bank: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};

const CLOZE_WITH_BANK_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'cloze_with_bank part_config',
  type: 'object',
  additionalProperties: false,
  required: ['text', 'gaps', 'bank'],
  properties: {
    text: { type: 'string', minLength: 1 },
    gaps: { type: 'array', minItems: 1, items: CLOZE_GAP_SCHEMA },
    bank: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
  },
};

const CLOZE_CODE_SCHEMA: WidgetConfigSchema = {
  ...CLOZE_FREE_SCHEMA,
  title: 'cloze_code part_config',
};

const TRACE_TABLE_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'trace_table part_config',
  type: 'object',
  additionalProperties: false,
  required: ['columns', 'rows', 'expected', 'marking'],
  properties: {
    columns: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          width: { type: 'integer', minimum: 1 },
        },
      },
    },
    rows: { type: 'integer', minimum: 1 },
    prefill: {
      type: 'object',
      additionalProperties: { type: 'string', minLength: 1 },
      patternProperties: { '^\\d+,\\d+$': { type: 'string', minLength: 1 } },
    },
    expected: {
      type: 'object',
      additionalProperties: { type: 'string', minLength: 1 },
      patternProperties: { '^\\d+,\\d+$': { type: 'string', minLength: 1 } },
    },
    marking: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['perCell', 'perRow', 'allOrNothing'] },
        caseSensitive: { type: 'boolean' },
        trimWhitespace: { type: 'boolean' },
      },
    },
  },
};

const MATCHING_SCHEMA: WidgetConfigSchema = {
  $schema: SCHEMA_DRAFT,
  title: 'matching part_config',
  type: 'object',
  additionalProperties: false,
  required: ['left', 'right', 'correctPairs'],
  properties: {
    left: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
    right: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
    correctPairs: {
      type: 'array',
      items: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { type: 'integer', minimum: 0 },
      },
    },
    partialCredit: { type: 'boolean' },
  },
};

const REGISTRATIONS: readonly WidgetRegistration[] = [
  {
    type: 'multiple_choice',
    marker: 'deterministic',
    displayName: 'Multiple choice',
    description:
      'Pupil picks one option from a small list. Marked deterministically against the option flagged is_correct.',
    markPointGuidance: 'One mark_point per correct option; mark_point.text is the option label.',
    configSchema: null,
    exampleConfig: null,
    validateConfig: configMustBeNull('multiple_choice'),
  },
  {
    type: 'tick_box',
    marker: 'deterministic',
    displayName: 'Tick box (pick several)',
    description:
      'Pupil ticks one or more options. Marked deterministically; partial credit is awarded per correct tick (and per missed distractor avoided).',
    markPointGuidance:
      'One mark_point per option that should be ticked. Use part_config.tickExactly when the question requires a fixed count of ticks.',
    configSchema: TICK_BOX_SCHEMA,
    exampleConfig: { tickExactly: 2 },
    validateConfig: validateTickBoxConfig,
  },
  {
    type: 'short_text',
    marker: 'deterministic',
    displayName: 'Short text answer',
    description:
      'A single-line free-text response (e.g. a term, name, or short phrase). Marked deterministically against mark_point.text and accepted_alternatives.',
    markPointGuidance:
      'One mark_point covering the expected answer; list alternative spellings in accepted_alternatives.',
    configSchema: null,
    exampleConfig: null,
    validateConfig: configMustBeNull('short_text'),
  },
  {
    type: 'medium_text',
    marker: 'teacher_pending',
    displayName: 'Medium text answer',
    description:
      'A short paragraph (typically 2–4 sentences). Sent to the teacher review queue rather than auto-marked.',
    markPointGuidance:
      'One mark_point per ideas-list bullet the answer should mention; pupils need not phrase them identically.',
    configSchema: null,
    exampleConfig: null,
    validateConfig: configMustBeNull('medium_text'),
  },
  {
    type: 'extended_response',
    marker: 'teacher_pending',
    displayName: 'Extended-response (6+ marks)',
    description:
      'A long-form response, typically banded against AO1/AO2/AO3. Sent to teacher review with a banded rubric.',
    markPointGuidance:
      'List mark_points as the assessable indicators (definitions, examples, evaluations); the teacher applies a banded judgement on top.',
    configSchema: null,
    exampleConfig: null,
    validateConfig: configMustBeNull('extended_response'),
  },
  {
    type: 'code',
    marker: 'teacher_pending',
    displayName: 'Code answer',
    description:
      'Pupil writes a code or pseudocode snippet. Sent to teacher review (a static checker is out of scope for J277).',
    markPointGuidance: 'One mark_point per behaviour or construct the snippet must include.',
    configSchema: null,
    exampleConfig: null,
    validateConfig: configMustBeNull('code'),
  },
  {
    type: 'algorithm',
    marker: 'teacher_pending',
    displayName: 'Algorithm description',
    description:
      'Pupil describes an algorithm in prose, pseudocode, or numbered steps. Sent to teacher review.',
    markPointGuidance: 'One mark_point per discrete step or condition the algorithm must include.',
    configSchema: null,
    exampleConfig: null,
    validateConfig: configMustBeNull('algorithm'),
  },
  {
    type: 'trace_table',
    marker: 'deterministic',
    displayName: 'Trace table / truth table',
    description:
      'Pupil completes a grid: variable columns × iteration rows for a trace table, or input/output columns × 2ⁿ rows for a truth table. Pre-filled cells render as read-only text; pupils only fill the empty cells.',
    markPointGuidance:
      'One mark_point per author-marked cell, in row-then-column order. Cells the author leaves out of part_config.expected are decorative.',
    configSchema: TRACE_TABLE_SCHEMA,
    exampleConfig: {
      columns: [{ name: 'i' }, { name: 'total' }],
      rows: 2,
      prefill: { '0,0': '1' },
      expected: { '0,1': '2', '1,0': '2', '1,1': '6' },
      marking: { mode: 'perCell' },
    },
    validateConfig: (c) => validateTraceGridConfigShape(c).map((m) => ({ message: m })),
  },
  {
    type: 'matrix_tick_single',
    marker: 'deterministic',
    displayName: 'Matrix (one tick per row)',
    description:
      'A grid where each row demands exactly one tick — for example, classifying items into categories.',
    markPointGuidance:
      'One mark_point per row, naming the row plus its correct column (e.g. "Bubble sort — sorting algorithm").',
    configSchema: MATRIX_TICK_SINGLE_SCHEMA,
    exampleConfig: {
      rows: ['Bubble sort', 'Linear search'],
      columns: ['Sorting', 'Searching'],
      correctByRow: ['Sorting', 'Searching'],
      allOrNothing: false,
    },
    validateConfig: validateMatrixTickSingleConfig,
  },
  {
    type: 'matrix_tick_multi',
    marker: 'deterministic',
    displayName: 'Matrix (multiple ticks per row)',
    description:
      'A grid where each row may demand zero, one, or several ticks — for example, identifying every property that applies.',
    markPointGuidance:
      'One mark_point per (row, correct-column) pair the pupil must tick. Set partialCredit=false if the row is all-or-nothing.',
    configSchema: MATRIX_TICK_MULTI_SCHEMA,
    exampleConfig: {
      rows: ['RAM', 'ROM'],
      columns: ['Volatile', 'Read-only', 'Stores BIOS'],
      correctByRow: [['Volatile'], ['Read-only', 'Stores BIOS']],
      partialCredit: true,
    },
    validateConfig: validateMatrixTickMultiConfig,
  },
  {
    type: 'cloze_free',
    marker: 'deterministic',
    displayName: 'Cloze — free typing',
    description:
      'A passage with {{gap}} markers that the pupil fills in by typing. Each gap has its own accept-list.',
    markPointGuidance:
      'One mark_point per gap, in the same order as the gaps appear in part_config.text.',
    configSchema: CLOZE_FREE_SCHEMA,
    exampleConfig: {
      text: 'Eight bits make a {{u1}}.',
      gaps: [{ id: 'u1', accept: ['byte'] }],
    },
    validateConfig: (c) =>
      validateClozeConfigShape(c, { requireBank: false }).map((m) => ({ message: m })),
  },
  {
    type: 'cloze_with_bank',
    marker: 'deterministic',
    displayName: 'Cloze — pick from a bank',
    description:
      'A passage with {{gap}} markers; the pupil picks from a bank of terms (which may include distractors).',
    markPointGuidance:
      'One mark_point per gap, in document order. Include distractors in part_config.bank — they need no mark_point.',
    configSchema: CLOZE_WITH_BANK_SCHEMA,
    exampleConfig: {
      text: 'A {{d1}} forwards within a LAN.',
      gaps: [{ id: 'd1', accept: ['switch'] }],
      bank: ['switch', 'router', 'hub'],
    },
    validateConfig: (c) =>
      validateClozeConfigShape(c, { requireBank: true }).map((m) => ({ message: m })),
  },
  {
    type: 'matching',
    marker: 'deterministic',
    displayName: 'Matching — pair prompts to options',
    description:
      'Pupil pairs each left-column prompt with one right-column option. Right column may include distractors; options may legitimately be shared across multiple prompts.',
    markPointGuidance:
      'One mark_point per left row, in the same order as part_config.left; mark_point.text names the correct pairing (e.g. "HTTP — web page transfer").',
    configSchema: MATCHING_SCHEMA,
    exampleConfig: {
      left: ['HTTP', 'SMTP', 'FTP'],
      right: ['web pages', 'email', 'file transfer', 'remote shell'],
      correctPairs: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      partialCredit: true,
    },
    validateConfig: (c) => validateMatchingConfigShape(c).map((m) => ({ message: m })),
  },
  {
    type: 'cloze_code',
    marker: 'deterministic',
    displayName: 'Cloze — code / pseudocode',
    description:
      'A {{gap}}-marked code or pseudocode snippet rendered in a monospace block; pupil types into each gap.',
    markPointGuidance:
      'One mark_point per gap, in document order. Use accept lists rather than caseSensitive when keywords have a single canonical form.',
    configSchema: CLOZE_CODE_SCHEMA,
    exampleConfig: {
      text: 'for i = 1 to {{stop}}\n  print({{counter}})\nnext i',
      gaps: [
        { id: 'stop', accept: ['5'] },
        { id: 'counter', accept: ['i'] },
      ],
    },
    validateConfig: (c) =>
      validateClozeConfigShape(c, { requireBank: false }).map((m) => ({ message: m })),
  },
];

function validateTickBoxConfig(config: unknown): PartConfigIssue[] {
  if (config === null || config === undefined) return [];
  if (typeof config !== 'object' || Array.isArray(config)) {
    return [{ message: "Widget 'tick_box' part_config must be an object if present." }];
  }
  const cfg = config as Record<string, unknown>;
  const tickExactly = cfg['tickExactly'];
  const options = cfg['options'];
  const issues: PartConfigIssue[] = [];

  for (const key of Object.keys(cfg)) {
    if (key !== 'tickExactly' && key !== 'options') {
      issues.push({ message: `tick_box.part_config has unsupported key '${key}'.` });
    }
  }

  if (tickExactly !== undefined && tickExactly !== null) {
    if (typeof tickExactly !== 'number' || !Number.isInteger(tickExactly) || tickExactly < 1) {
      issues.push({ message: 'tick_box.tickExactly must be a positive integer.' });
    }
  }

  if (options !== undefined && options !== null) {
    if (!Array.isArray(options) || options.length === 0) {
      issues.push({ message: 'tick_box.options must be a non-empty string array if present.' });
    } else if (!options.every((o) => typeof o === 'string' && o.length > 0)) {
      issues.push({ message: 'tick_box.options entries must be non-empty strings.' });
    } else if (new Set(options as string[]).size !== options.length) {
      issues.push({ message: 'tick_box.options must not list the same value twice.' });
    }
  }

  return issues;
}

function validateMatrixTickSingleConfig(config: unknown): PartConfigIssue[] {
  if (config === null || config === undefined) {
    return [{ message: "Widget 'matrix_tick_single' requires a part_config payload." }];
  }
  if (typeof config !== 'object') {
    return [{ message: "Widget 'matrix_tick_single' part_config must be an object." }];
  }
  const cfg = config as Record<string, unknown>;
  const rows = cfg['rows'];
  const columns = cfg['columns'];
  const correctByRow = cfg['correctByRow'];
  const allOrNothing = cfg['allOrNothing'];
  const issues: PartConfigIssue[] = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    issues.push({ message: 'matrix_tick_single.rows must be a non-empty string array.' });
  } else if (!rows.every((r) => typeof r === 'string' && r.length > 0)) {
    issues.push({ message: 'matrix_tick_single.rows entries must be non-empty strings.' });
  }

  if (!Array.isArray(columns) || columns.length < 2) {
    issues.push({ message: 'matrix_tick_single.columns must list at least two strings.' });
  } else if (!columns.every((c) => typeof c === 'string' && c.length > 0)) {
    issues.push({ message: 'matrix_tick_single.columns entries must be non-empty strings.' });
  }

  if (!Array.isArray(correctByRow)) {
    issues.push({ message: 'matrix_tick_single.correctByRow must be a string array.' });
  } else if (!correctByRow.every((c) => typeof c === 'string' && c.length > 0)) {
    issues.push({ message: 'matrix_tick_single.correctByRow entries must be non-empty strings.' });
  } else if (Array.isArray(rows) && correctByRow.length !== rows.length) {
    issues.push({
      message: 'matrix_tick_single.correctByRow length must match matrix_tick_single.rows length.',
    });
  } else if (Array.isArray(columns)) {
    const cols = new Set(columns as string[]);
    for (const c of correctByRow as string[]) {
      if (!cols.has(c)) {
        issues.push({
          message: `matrix_tick_single.correctByRow value '${c}' is not in matrix_tick_single.columns.`,
        });
      }
    }
  }

  if (allOrNothing !== undefined && allOrNothing !== null && typeof allOrNothing !== 'boolean') {
    issues.push({ message: 'matrix_tick_single.allOrNothing must be a boolean if present.' });
  }

  return issues;
}

function validateMatrixTickMultiConfig(config: unknown): PartConfigIssue[] {
  if (config === null || config === undefined) {
    return [{ message: "Widget 'matrix_tick_multi' requires a part_config payload." }];
  }
  if (typeof config !== 'object') {
    return [{ message: "Widget 'matrix_tick_multi' part_config must be an object." }];
  }
  const cfg = config as Record<string, unknown>;
  const rows = cfg['rows'];
  const columns = cfg['columns'];
  const correctByRow = cfg['correctByRow'];
  const partialCredit = cfg['partialCredit'];
  const issues: PartConfigIssue[] = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    issues.push({ message: 'matrix_tick_multi.rows must be a non-empty string array.' });
  } else if (!rows.every((r) => typeof r === 'string' && r.length > 0)) {
    issues.push({ message: 'matrix_tick_multi.rows entries must be non-empty strings.' });
  }

  if (!Array.isArray(columns) || columns.length < 2) {
    issues.push({ message: 'matrix_tick_multi.columns must list at least two strings.' });
  } else if (!columns.every((c) => typeof c === 'string' && c.length > 0)) {
    issues.push({ message: 'matrix_tick_multi.columns entries must be non-empty strings.' });
  }

  if (!Array.isArray(correctByRow)) {
    issues.push({
      message: 'matrix_tick_multi.correctByRow must be an array of column-name arrays.',
    });
  } else if (Array.isArray(rows) && correctByRow.length !== rows.length) {
    issues.push({
      message: 'matrix_tick_multi.correctByRow length must match matrix_tick_multi.rows length.',
    });
  } else {
    const cols =
      Array.isArray(columns) && columns.every((c): c is string => typeof c === 'string')
        ? new Set(columns)
        : null;
    for (let i = 0; i < correctByRow.length; i++) {
      const row: unknown = correctByRow[i];
      if (!Array.isArray(row)) {
        issues.push({
          message: `matrix_tick_multi.correctByRow[${i}] must be an array of column names.`,
        });
        continue;
      }
      if (!row.every((c): c is string => typeof c === 'string' && c.length > 0)) {
        issues.push({
          message: `matrix_tick_multi.correctByRow[${i}] entries must be non-empty strings.`,
        });
        continue;
      }
      const rowStrings: string[] = row;
      if (cols !== null) {
        for (const c of rowStrings) {
          if (!cols.has(c)) {
            issues.push({
              message: `matrix_tick_multi.correctByRow[${i}] value '${c}' is not in matrix_tick_multi.columns.`,
            });
          }
        }
        if (new Set(rowStrings).size !== rowStrings.length) {
          issues.push({
            message: `matrix_tick_multi.correctByRow[${i}] must not list a column twice.`,
          });
        }
      }
    }
  }

  if (partialCredit !== undefined && partialCredit !== null && typeof partialCredit !== 'boolean') {
    issues.push({ message: 'matrix_tick_multi.partialCredit must be a boolean if present.' });
  }

  return issues;
}

export const WIDGET_REGISTRY: ReadonlyMap<string, WidgetRegistration> = new Map(
  REGISTRATIONS.map((r) => [r.type, r]),
);

export function getWidget(type: string): WidgetRegistration | undefined {
  return WIDGET_REGISTRY.get(type);
}

export function validatePartConfig(type: string, config: unknown): PartConfigIssue[] {
  const widget = WIDGET_REGISTRY.get(type);
  if (!widget) return [{ message: `Unknown widget type '${type}'.` }];
  return widget.validateConfig(config);
}

export function registeredWidgetTypes(): readonly string[] {
  return REGISTRATIONS.map((r) => r.type);
}

/**
 * JSON-safe view of one widget — drops the runtime `validateConfig`
 * function so the descriptor can be served over HTTP and snapshotted
 * to disk by the schema generator.
 */
export interface WidgetDescriptor {
  type: string;
  marker: WidgetMarker;
  displayName: string;
  description: string;
  markPointGuidance: string;
  configSchema: WidgetConfigSchema | null;
  exampleConfig: unknown;
}

function toDescriptor(r: WidgetRegistration): WidgetDescriptor {
  return {
    type: r.type,
    marker: r.marker,
    displayName: r.displayName,
    description: r.description,
    markPointGuidance: r.markPointGuidance,
    configSchema: r.configSchema,
    exampleConfig: r.exampleConfig,
  };
}

export function widgetDescriptors(): readonly WidgetDescriptor[] {
  return REGISTRATIONS.map(toDescriptor);
}

/**
 * The committed `docs/widgets.schema.json` snapshot. Bumping this
 * version when the descriptor shape itself changes (not when a widget
 * is added) makes deliberate breakage visible to wizard consumers.
 */
export const WIDGET_REGISTRY_VERSION = '1.0.0';

export function widgetRegistryDocument(): {
  version: string;
  generatedFor: string;
  widgets: readonly WidgetDescriptor[];
} {
  return {
    version: WIDGET_REGISTRY_VERSION,
    generatedFor: 'OCR J277 question wizard / external integrations',
    widgets: widgetDescriptors(),
  };
}

// Coverage assertion run at module load: every value listed in
// EXPECTED_RESPONSE_TYPES must have a registry entry, and vice versa.
// Catches out-of-sync drift the moment a developer adds a new type to
// one place but forgets the other. The exhaustiveness test in
// tests/unit/widgets.test.ts repeats this for CI visibility.
{
  const registered = new Set(REGISTRATIONS.map((r) => r.type));
  const expected = new Set(EXPECTED_RESPONSE_TYPES);
  for (const t of expected) {
    if (!registered.has(t)) {
      throw new Error(
        `Widget registry is missing an entry for response type '${t}' (listed in EXPECTED_RESPONSE_TYPES).`,
      );
    }
  }
  for (const t of registered) {
    if (!expected.has(t)) {
      throw new Error(
        `Widget registry has entry for '${t}' which is not in EXPECTED_RESPONSE_TYPES.`,
      );
    }
  }
}
