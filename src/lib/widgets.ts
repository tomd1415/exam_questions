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

export type WidgetMarker = 'deterministic' | 'teacher_pending';

export interface PartConfigIssue {
  message: string;
}

export interface WidgetRegistration {
  /** Response-type code, must appear in EXPECTED_RESPONSE_TYPES. */
  type: string;
  /** Whether this widget can be marked without a teacher in the loop. */
  marker: WidgetMarker;
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

const REGISTRATIONS: readonly WidgetRegistration[] = [
  {
    type: 'multiple_choice',
    marker: 'deterministic',
    validateConfig: configMustBeNull('multiple_choice'),
  },
  {
    type: 'tick_box',
    marker: 'deterministic',
    validateConfig: validateTickBoxConfig,
  },
  {
    type: 'short_text',
    marker: 'deterministic',
    validateConfig: configMustBeNull('short_text'),
  },
  {
    type: 'medium_text',
    marker: 'teacher_pending',
    validateConfig: configMustBeNull('medium_text'),
  },
  {
    type: 'extended_response',
    marker: 'teacher_pending',
    validateConfig: configMustBeNull('extended_response'),
  },
  {
    type: 'code',
    marker: 'teacher_pending',
    validateConfig: configMustBeNull('code'),
  },
  {
    type: 'algorithm',
    marker: 'teacher_pending',
    validateConfig: configMustBeNull('algorithm'),
  },
  {
    type: 'trace_table',
    marker: 'teacher_pending',
    validateConfig: configMustBeNull('trace_table'),
  },
  {
    type: 'matrix_tick_single',
    marker: 'deterministic',
    validateConfig: validateMatrixTickSingleConfig,
  },
  {
    type: 'matrix_tick_multi',
    marker: 'deterministic',
    validateConfig: validateMatrixTickMultiConfig,
  },
  {
    type: 'cloze_free',
    marker: 'deterministic',
    validateConfig: (c) =>
      validateClozeConfigShape(c, { requireBank: false }).map((m) => ({ message: m })),
  },
  {
    type: 'cloze_with_bank',
    marker: 'deterministic',
    validateConfig: (c) =>
      validateClozeConfigShape(c, { requireBank: true }).map((m) => ({ message: m })),
  },
  {
    type: 'cloze_code',
    marker: 'deterministic',
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
