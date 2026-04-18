// Schema-related tests for the widget registry.
//
//   1. exampleConfig sanity: every widget's exampleConfig is accepted
//      both by the functional validator AND its JSON Schema (if any).
//
//   2. parity: for each widget with a configSchema, a battery of
//      "schema-judgeable" fixtures is run through both the functional
//      validator and ajv. The schema cannot express semantic
//      cross-field invariants (e.g. correctByRow length matching
//      rows, cloze.text gap ids appearing in cloze.gaps); those
//      fixtures are kept in the functional-only bucket so the
//      registry's validator stays the source of truth.
//
//   3. descriptor metadata: every widget exposes non-empty
//      displayName / description / markPointGuidance.

import { describe, it, expect } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  WIDGET_REGISTRY,
  registeredWidgetTypes,
  validatePartConfig,
  widgetDescriptors,
} from '../../src/lib/widgets.js';

interface SchemaFixture {
  label: string;
  config: unknown;
  /** Whether both the functional validator and the JSON Schema must accept. */
  expectAccept: boolean;
}

// Fixtures that ajv and the functional validator must agree on. Keep
// to constraints expressible in pure JSON Schema (types, enums, lengths,
// uniqueness, regex).
const PARITY_FIXTURES: Record<string, SchemaFixture[]> = {
  tick_box: [
    { label: 'tickExactly only', config: { tickExactly: 2 }, expectAccept: true },
    {
      label: 'options + tickExactly',
      config: { tickExactly: 2, options: ['a', 'b', 'c'] },
      expectAccept: true,
    },
    { label: 'tickExactly = 0', config: { tickExactly: 0 }, expectAccept: false },
    { label: 'tickExactly fractional', config: { tickExactly: 1.5 }, expectAccept: false },
    { label: 'options empty', config: { options: [] }, expectAccept: false },
    { label: 'options has empty string', config: { options: ['a', ''] }, expectAccept: false },
    { label: 'options has duplicate', config: { options: ['a', 'a'] }, expectAccept: false },
  ],
  matrix_tick_single: [
    {
      label: 'minimal valid',
      config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: ['A'] },
      expectAccept: true,
    },
    {
      label: 'with allOrNothing',
      config: {
        rows: ['R1'],
        columns: ['A', 'B'],
        correctByRow: ['A'],
        allOrNothing: true,
      },
      expectAccept: true,
    },
    {
      label: 'rows empty',
      config: { rows: [], columns: ['A', 'B'], correctByRow: [] },
      expectAccept: false,
    },
    {
      label: 'columns under 2',
      config: { rows: ['R1'], columns: ['A'], correctByRow: ['A'] },
      expectAccept: false,
    },
    {
      label: 'allOrNothing wrong type',
      config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: ['A'], allOrNothing: 'yes' },
      expectAccept: false,
    },
  ],
  matrix_tick_multi: [
    {
      label: 'minimal valid',
      config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: [['A']] },
      expectAccept: true,
    },
    {
      label: 'duplicate within row',
      config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: [['A', 'A']] },
      expectAccept: false,
    },
    {
      label: 'partialCredit wrong type',
      config: {
        rows: ['R1'],
        columns: ['A', 'B'],
        correctByRow: [['A']],
        partialCredit: 'yes',
      },
      expectAccept: false,
    },
  ],
  cloze_free: [
    {
      label: 'single gap',
      config: { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['y'] }] },
      expectAccept: true,
    },
    {
      label: 'gap id with bad chars',
      config: { text: 'A {{x}}.', gaps: [{ id: 'has space', accept: ['y'] }] },
      expectAccept: false,
    },
    {
      label: 'accept empty array',
      config: { text: 'A {{x}}.', gaps: [{ id: 'x', accept: [] }] },
      expectAccept: false,
    },
    {
      label: 'gaps empty',
      config: { text: 'A.', gaps: [] },
      expectAccept: false,
    },
    {
      label: 'text empty',
      config: { text: '', gaps: [{ id: 'x', accept: ['y'] }] },
      expectAccept: false,
    },
  ],
  cloze_with_bank: [
    {
      label: 'minimal valid',
      config: {
        text: 'A {{x}}.',
        gaps: [{ id: 'x', accept: ['y'] }],
        bank: ['y', 'z'],
      },
      expectAccept: true,
    },
    {
      label: 'bank empty',
      config: { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['y'] }], bank: [] },
      expectAccept: false,
    },
    {
      label: 'bank duplicate',
      config: {
        text: 'A {{x}}.',
        gaps: [{ id: 'x', accept: ['y'] }],
        bank: ['y', 'y'],
      },
      expectAccept: false,
    },
    {
      label: 'bank missing entirely',
      config: { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['y'] }] },
      expectAccept: false,
    },
  ],
  cloze_code: [
    {
      label: 'minimal valid',
      config: { text: 'x = {{r}}', gaps: [{ id: 'r', accept: ['1'] }] },
      expectAccept: true,
    },
    {
      label: 'no gaps',
      config: { text: 'x = 1', gaps: [] },
      expectAccept: false,
    },
  ],
  matching: [
    {
      label: 'minimal valid',
      config: {
        left: ['a'],
        right: ['x', 'y'],
        correctPairs: [[0, 0]],
      },
      expectAccept: true,
    },
    {
      label: 'with partialCredit=false',
      config: {
        left: ['a', 'b'],
        right: ['x', 'y'],
        correctPairs: [
          [0, 0],
          [1, 1],
        ],
        partialCredit: false,
      },
      expectAccept: true,
    },
    {
      label: 'left empty',
      config: { left: [], right: ['x'], correctPairs: [] },
      expectAccept: false,
    },
    {
      label: 'left has duplicate',
      config: {
        left: ['a', 'a'],
        right: ['x', 'y'],
        correctPairs: [
          [0, 0],
          [1, 1],
        ],
      },
      expectAccept: false,
    },
    {
      label: 'correctPairs entry not a pair',
      config: { left: ['a'], right: ['x'], correctPairs: [[0, 0, 1]] },
      expectAccept: false,
    },
    {
      label: 'partialCredit wrong type',
      config: { left: ['a'], right: ['x'], correctPairs: [[0, 0]], partialCredit: 'yes' },
      expectAccept: false,
    },
  ],
  trace_table: [
    {
      label: 'minimal valid grid',
      config: {
        columns: [{ name: 'i' }, { name: 'total' }],
        rows: 1,
        expected: { '0,1': '2' },
        marking: { mode: 'perCell' },
      },
      expectAccept: true,
    },
    {
      label: 'with prefill and case-sensitive marking',
      config: {
        columns: [{ name: 'i' }, { name: 'total' }],
        rows: 2,
        prefill: { '0,0': '1' },
        expected: { '0,1': '2', '1,0': '2', '1,1': '6' },
        marking: { mode: 'perRow', caseSensitive: true },
      },
      expectAccept: true,
    },
    {
      label: 'columns empty',
      config: {
        columns: [],
        rows: 1,
        expected: {},
        marking: { mode: 'perCell' },
      },
      expectAccept: false,
    },
    {
      label: 'rows = 0',
      config: {
        columns: [{ name: 'i' }],
        rows: 0,
        expected: {},
        marking: { mode: 'perCell' },
      },
      expectAccept: false,
    },
    {
      label: 'unknown marking mode',
      config: {
        columns: [{ name: 'i' }],
        rows: 1,
        expected: {},
        marking: { mode: 'random' },
      },
      expectAccept: false,
    },
  ],
};

function buildAjv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: false });
}

describe('widget descriptor metadata', () => {
  it('every registered widget has non-empty display copy', () => {
    for (const d of widgetDescriptors()) {
      expect(d.displayName.length, `${d.type} displayName`).toBeGreaterThan(0);
      expect(d.description.length, `${d.type} description`).toBeGreaterThan(0);
      expect(d.markPointGuidance.length, `${d.type} markPointGuidance`).toBeGreaterThan(0);
    }
  });

  it('null configSchema is paired with null exampleConfig (and vice versa)', () => {
    for (const d of widgetDescriptors()) {
      if (d.configSchema === null) {
        expect(d.exampleConfig, `${d.type}`).toBeNull();
      } else {
        expect(d.exampleConfig, `${d.type}`).not.toBeNull();
      }
    }
  });
});

describe('widget exampleConfig', () => {
  it('passes both the functional validator and the JSON Schema for every widget', () => {
    const ajv = buildAjv();
    for (const d of widgetDescriptors()) {
      const issues = validatePartConfig(d.type, d.exampleConfig);
      expect(issues, `${d.type} functional rejected its own example`).toEqual([]);
      if (d.configSchema !== null) {
        const validate = ajv.compile(d.configSchema);
        const ok = validate(d.exampleConfig);
        expect(ok, `${d.type} schema rejected example: ${JSON.stringify(validate.errors)}`).toBe(
          true,
        );
      }
    }
  });
});

describe('widget configSchema parity (schema-judgeable cases)', () => {
  const ajv = buildAjv();
  for (const type of Object.keys(PARITY_FIXTURES)) {
    const schema = WIDGET_REGISTRY.get(type)?.configSchema;
    if (schema == null) {
      throw new Error(`PARITY_FIXTURES references '${type}' which has no schema.`);
    }
    const validate = ajv.compile(schema);
    for (const fix of PARITY_FIXTURES[type]!) {
      it(`${type}: ${fix.label}`, () => {
        const functionalIssues = validatePartConfig(type, fix.config);
        const functionalOk = functionalIssues.length === 0;
        const schemaOk = validate(fix.config);
        expect(functionalOk, `functional accepted=${functionalOk}`).toBe(fix.expectAccept);
        expect(
          schemaOk,
          `schema accepted=${schemaOk} errors=${JSON.stringify(validate.errors)}`,
        ).toBe(fix.expectAccept);
      });
    }
  }
});

describe('widget configSchema is at least as strict as the functional validator', () => {
  // For widgets where additionalProperties:false is a deliberate
  // wizard-facing tightening, the schema can reject inputs the
  // functional validator currently accepts. This test documents that
  // direction explicitly so the wizard can rely on it.
  const ajv = buildAjv();
  const STRICTER_SCHEMA_CASES: { type: string; label: string; config: unknown }[] = [
    {
      type: 'tick_box',
      label: 'rejects unknown top-level key',
      config: { mystery: true },
    },
    {
      type: 'matrix_tick_single',
      label: 'rejects unknown top-level key',
      config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: ['A'], extra: 1 },
    },
    {
      type: 'matrix_tick_multi',
      label: 'rejects unknown top-level key',
      config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: [['A']], extra: 1 },
    },
    {
      type: 'cloze_free',
      label: 'rejects unknown gap-level key',
      config: { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['y'], extra: 1 }] },
    },
  ];

  for (const c of STRICTER_SCHEMA_CASES) {
    it(`${c.type}: ${c.label}`, () => {
      const reg = WIDGET_REGISTRY.get(c.type);
      expect(reg?.configSchema).not.toBeNull();
      const validate = ajv.compile(reg!.configSchema!);
      expect(validate(c.config)).toBe(false);
    });
  }
});

describe('widget configSchema completeness', () => {
  it('schema is null iff the widget marker accepts no config (legacy widgets)', () => {
    const noConfig = new Set([
      'multiple_choice',
      'short_text',
      'medium_text',
      'extended_response',
      'code',
      'algorithm',
    ]);
    for (const type of registeredWidgetTypes()) {
      const reg = WIDGET_REGISTRY.get(type)!;
      if (noConfig.has(type)) {
        expect(reg.configSchema, `${type} should have null schema`).toBeNull();
      } else {
        expect(reg.configSchema, `${type} should have a schema`).not.toBeNull();
      }
    }
  });
});
