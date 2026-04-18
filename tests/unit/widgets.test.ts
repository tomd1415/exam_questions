import { describe, it, expect } from 'vitest';
import { EXPECTED_RESPONSE_TYPES } from '../../src/lib/question-invariants.js';
import {
  WIDGET_REGISTRY,
  getWidget,
  registeredWidgetTypes,
  validatePartConfig,
} from '../../src/lib/widgets.js';
import {
  OBJECTIVE_RESPONSE_TYPES,
  OPEN_RESPONSE_TYPES,
} from '../../src/services/marking/deterministic.js';

describe('widget registry', () => {
  it('has an entry for every EXPECTED_RESPONSE_TYPES value', () => {
    for (const type of EXPECTED_RESPONSE_TYPES) {
      expect(WIDGET_REGISTRY.has(type), `missing registry entry for '${type}'`).toBe(true);
    }
  });

  it('has no entries beyond EXPECTED_RESPONSE_TYPES', () => {
    const expected = new Set(EXPECTED_RESPONSE_TYPES);
    for (const type of registeredWidgetTypes()) {
      expect(expected.has(type), `unexpected registry entry '${type}'`).toBe(true);
    }
  });

  it('agrees with the deterministic marker about which types are objective', () => {
    for (const type of EXPECTED_RESPONSE_TYPES) {
      const widget = getWidget(type);
      expect(widget).toBeDefined();
      const isObjective = OBJECTIVE_RESPONSE_TYPES.has(type);
      const isOpen = OPEN_RESPONSE_TYPES.has(type);
      expect(
        isObjective || isOpen,
        `'${type}' must appear in OBJECTIVE_RESPONSE_TYPES or OPEN_RESPONSE_TYPES`,
      ).toBe(true);
      const expectedMarker = isObjective ? 'deterministic' : 'teacher_pending';
      expect(widget!.marker).toBe(expectedMarker);
    }
  });
});

// Widget types that accept null/undefined as a valid config. tick_box is
// in this list because the default behaviour (one checkbox per mark
// point, no tickExactly counter) is preserved when part_config is null;
// see the dedicated tick_box test below for the optional shape.
const NO_CONFIG_WIDGETS: readonly string[] = [
  'multiple_choice',
  'tick_box',
  'short_text',
  'medium_text',
  'extended_response',
  'code',
  'algorithm',
];

// tick_box accepts a part_config but it is optional, so it is excluded
// from the "rejects non-null config" sweep below.
const STRICTLY_NO_CONFIG_WIDGETS: readonly string[] = NO_CONFIG_WIDGETS.filter(
  (t) => t !== 'tick_box',
);

describe('validatePartConfig', () => {
  it('accepts null and undefined for every legacy no-config widget', () => {
    for (const type of NO_CONFIG_WIDGETS) {
      expect(validatePartConfig(type, null)).toEqual([]);
      expect(validatePartConfig(type, undefined)).toEqual([]);
    }
  });

  it('rejects a non-null config for legacy widgets that take none', () => {
    for (const type of STRICTLY_NO_CONFIG_WIDGETS) {
      const issues = validatePartConfig(type, { rows: 3 });
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it('reports unknown widget types', () => {
    const issues = validatePartConfig('zombie_type', null);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/unknown widget/i);
  });

  it('matrix_tick_single requires a config and validates rows/columns/correctByRow', () => {
    expect(validatePartConfig('matrix_tick_single', null).length).toBeGreaterThan(0);
    expect(validatePartConfig('matrix_tick_single', 'string').length).toBeGreaterThan(0);

    const ok = {
      rows: ['R1', 'R2'],
      columns: ['A', 'B'],
      correctByRow: ['A', 'B'],
    };
    expect(validatePartConfig('matrix_tick_single', ok)).toEqual([]);

    const wrongLength = {
      rows: ['R1', 'R2'],
      columns: ['A', 'B'],
      correctByRow: ['A'],
    };
    expect(validatePartConfig('matrix_tick_single', wrongLength).length).toBeGreaterThan(0);

    const correctOutsideColumns = {
      rows: ['R1'],
      columns: ['A', 'B'],
      correctByRow: ['Z'],
    };
    expect(validatePartConfig('matrix_tick_single', correctOutsideColumns).length).toBeGreaterThan(
      0,
    );

    const badAllOrNothing = {
      rows: ['R1'],
      columns: ['A', 'B'],
      correctByRow: ['A'],
      allOrNothing: 'yes',
    };
    expect(validatePartConfig('matrix_tick_single', badAllOrNothing).length).toBeGreaterThan(0);
  });

  it('matrix_tick_multi requires per-row arrays of column names within columns', () => {
    expect(validatePartConfig('matrix_tick_multi', null).length).toBeGreaterThan(0);
    expect(validatePartConfig('matrix_tick_multi', 'string').length).toBeGreaterThan(0);

    const ok = {
      rows: ['R1', 'R2'],
      columns: ['A', 'B', 'C'],
      correctByRow: [['A', 'B'], ['C']],
      partialCredit: true,
    };
    expect(validatePartConfig('matrix_tick_multi', ok)).toEqual([]);

    const wrongLength = {
      rows: ['R1', 'R2'],
      columns: ['A', 'B'],
      correctByRow: [['A']],
    };
    expect(validatePartConfig('matrix_tick_multi', wrongLength).length).toBeGreaterThan(0);

    const rowNotArray = {
      rows: ['R1'],
      columns: ['A', 'B'],
      correctByRow: ['A'],
    };
    expect(validatePartConfig('matrix_tick_multi', rowNotArray).length).toBeGreaterThan(0);

    const valueOutsideColumns = {
      rows: ['R1'],
      columns: ['A', 'B'],
      correctByRow: [['A', 'Z']],
    };
    expect(validatePartConfig('matrix_tick_multi', valueOutsideColumns).length).toBeGreaterThan(0);

    const duplicateInRow = {
      rows: ['R1'],
      columns: ['A', 'B'],
      correctByRow: [['A', 'A']],
    };
    expect(validatePartConfig('matrix_tick_multi', duplicateInRow).length).toBeGreaterThan(0);

    const badPartialCredit = {
      rows: ['R1'],
      columns: ['A', 'B'],
      correctByRow: [['A']],
      partialCredit: 'yes',
    };
    expect(validatePartConfig('matrix_tick_multi', badPartialCredit).length).toBeGreaterThan(0);
  });

  it('tick_box accepts an optional tickExactly + options part_config', () => {
    expect(validatePartConfig('tick_box', null)).toEqual([]);
    expect(validatePartConfig('tick_box', { tickExactly: 2 })).toEqual([]);
    expect(
      validatePartConfig('tick_box', {
        tickExactly: 2,
        options: ['a', 'b', 'c'],
      }),
    ).toEqual([]);

    expect(validatePartConfig('tick_box', { tickExactly: 0 }).length).toBeGreaterThan(0);
    expect(validatePartConfig('tick_box', { tickExactly: 1.5 }).length).toBeGreaterThan(0);
    expect(validatePartConfig('tick_box', { options: [] }).length).toBeGreaterThan(0);
    expect(validatePartConfig('tick_box', { options: ['a', ''] }).length).toBeGreaterThan(0);
    expect(validatePartConfig('tick_box', { options: ['a', 'a'] }).length).toBeGreaterThan(0);
    expect(validatePartConfig('tick_box', { mystery: true }).length).toBeGreaterThan(0);
  });
});
