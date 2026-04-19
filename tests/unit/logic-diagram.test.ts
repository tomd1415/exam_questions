import { describe, it, expect } from 'vitest';
import {
  LOGIC_DIAGRAM_DATA_URL_PREFIX,
  MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH,
  isLogicDiagramConfig,
  markLogicDiagramBooleanExpression,
  markLogicDiagramGates,
  markLogicDiagramPalette,
  markLogicDiagramSlots,
  parseLogicDiagramBooleanRawAnswer,
  parseLogicDiagramGatesRawAnswer,
  parseLogicDiagramPaletteRawAnswer,
  parseLogicDiagramRawAnswer,
  parseLogicDiagramSlotsRawAnswer,
  serialiseLogicDiagramAnswer,
  serialiseLogicDiagramBooleanAnswer,
  serialiseLogicDiagramGatesAnswer,
  serialiseLogicDiagramPaletteAnswer,
  serialiseLogicDiagramSlotsAnswer,
  tokeniseBooleanExpression,
  validateLogicDiagramConfigShape,
  type LogicDiagramBooleanExpressionConfig,
  type LogicDiagramGateInBoxConfig,
  type LogicDiagramGatePaletteConfig,
  type LogicDiagramGuidedSlotsConfig,
} from '../../src/lib/logic-diagram.js';

const VALID_PNG = `${LOGIC_DIAGRAM_DATA_URL_PREFIX}iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=`;

describe('validateLogicDiagramConfigShape', () => {
  it('accepts a minimal valid config', () => {
    expect(
      validateLogicDiagramConfigShape({ variant: 'image', canvas: { width: 600, height: 400 } }),
    ).toEqual([]);
  });

  it('requires variant', () => {
    expect(validateLogicDiagramConfigShape({ canvas: { width: 600, height: 400 } })).toEqual(
      expect.arrayContaining([expect.stringContaining('variant')]),
    );
  });

  it('rejects unknown variants', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'structured_free',
      canvas: { width: 600, height: 400 },
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining("variant 'structured_free'")]),
    );
  });

  it('requires canvas with width and height', () => {
    expect(validateLogicDiagramConfigShape({ variant: 'image' })).toEqual(
      expect.arrayContaining([expect.stringContaining('canvas')]),
    );
    expect(validateLogicDiagramConfigShape({ variant: 'image', canvas: { width: 600 } })).toEqual(
      expect.arrayContaining([expect.stringContaining('height')]),
    );
  });

  it('clamps canvas dimensions to a sensible range', () => {
    expect(
      validateLogicDiagramConfigShape({ variant: 'image', canvas: { width: 50, height: 400 } }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('width')]));
    expect(
      validateLogicDiagramConfigShape({
        variant: 'image',
        canvas: { width: 600, height: 5000 },
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('height')]));
  });

  it('rejects unknown top-level or canvas keys', () => {
    expect(
      validateLogicDiagramConfigShape({
        variant: 'image',
        canvas: { width: 600, height: 400 },
        palette: ['AND'],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("'palette'")]));
    expect(
      validateLogicDiagramConfigShape({
        variant: 'image',
        canvas: { width: 600, height: 400, depth: 1 },
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("'depth'")]));
  });

  it('isLogicDiagramConfig matches validateLogicDiagramConfigShape', () => {
    expect(isLogicDiagramConfig({ variant: 'image', canvas: { width: 200, height: 200 } })).toBe(
      true,
    );
    expect(isLogicDiagramConfig({ variant: 'image' })).toBe(false);
  });
});

describe('parseLogicDiagramRawAnswer', () => {
  it('returns null for an empty string', () => {
    expect(parseLogicDiagramRawAnswer('')).toEqual({ image: null, errors: [] });
  });

  it('parses a single image= line into a data URL', () => {
    const out = parseLogicDiagramRawAnswer(`image=${VALID_PNG}`);
    expect(out.image).toBe(VALID_PNG);
    expect(out.errors).toEqual([]);
  });

  it('rejects non-PNG data URLs', () => {
    const out = parseLogicDiagramRawAnswer('image=data:image/svg+xml;base64,PHN2Zy8+');
    expect(out.image).toBeNull();
    expect(out.errors[0]).toContain(LOGIC_DIAGRAM_DATA_URL_PREFIX);
  });

  it('rejects malformed base64 payloads', () => {
    const out = parseLogicDiagramRawAnswer(`${LOGIC_DIAGRAM_DATA_URL_PREFIX}!!!not base64!!!`);
    // The line above has no leading "image=" so it parses as an unknown
    // line — re-test with the proper key:
    const real = parseLogicDiagramRawAnswer(
      `image=${LOGIC_DIAGRAM_DATA_URL_PREFIX}!!!not base64!!!`,
    );
    expect(real.image).toBeNull();
    expect(real.errors.some((e) => e.includes('base64'))).toBe(true);
    expect(out.image).toBeNull();
  });

  it('rejects oversized payloads', () => {
    const huge = 'A'.repeat(MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH + 1);
    const out = parseLogicDiagramRawAnswer(`image=${LOGIC_DIAGRAM_DATA_URL_PREFIX}${huge}`);
    expect(out.image).toBeNull();
    expect(out.errors.some((e) => e.includes('exceeds'))).toBe(true);
  });

  it('flags unknown keys but keeps the image', () => {
    const out = parseLogicDiagramRawAnswer(`notes=hello\nimage=${VALID_PNG}`);
    expect(out.image).toBe(VALID_PNG);
    expect(out.errors.some((e) => e.includes("'notes'"))).toBe(true);
  });
});

describe('serialiseLogicDiagramAnswer', () => {
  it('returns "" for null/empty', () => {
    expect(serialiseLogicDiagramAnswer(null)).toBe('');
    expect(serialiseLogicDiagramAnswer('')).toBe('');
  });

  it('round-trips with the parser', () => {
    const out = serialiseLogicDiagramAnswer(VALID_PNG);
    expect(out).toBe(`image=${VALID_PNG}`);
    expect(parseLogicDiagramRawAnswer(out).image).toBe(VALID_PNG);
  });
});

// ---------------------------------------------------------------------------
// Gate_in_box variant (chunk 2.5l)
// ---------------------------------------------------------------------------

const GIB_CFG: LogicDiagramGateInBoxConfig = {
  variant: 'gate_in_box',
  canvas: { width: 600, height: 400 },
  gates: [
    { id: 'g1', type: 'AND', x: 140, y: 60, width: 80, height: 50 },
    { id: 'g2', type: 'NOT', x: 140, y: 180, width: 80, height: 50 },
    { id: 'gout', x: 360, y: 110, width: 80, height: 50, accept: ['OR', 'or gate'] },
  ],
  terminals: [
    { id: 'a', kind: 'input', label: 'A', x: 40, y: 75 },
    { id: 'b', kind: 'input', label: 'B', x: 40, y: 125 },
    { id: 'c', kind: 'input', label: 'C', x: 40, y: 205 },
    { id: 'p', kind: 'output', label: 'P', x: 520, y: 135 },
  ],
  wires: [
    { from: 'a', to: 'g1' },
    { from: 'b', to: 'g1' },
    { from: 'c', to: 'g2' },
    { from: 'g1', to: 'gout' },
    { from: 'g2', to: 'gout' },
    { from: 'gout', to: 'p' },
  ],
};

describe('validateLogicDiagramConfigShape (gate_in_box variant)', () => {
  it('accepts a valid gate_in_box config', () => {
    expect(validateLogicDiagramConfigShape(GIB_CFG)).toEqual([]);
  });

  it('requires gates to be a non-empty array', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
      gates: [],
      terminals: [],
      wires: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining('gates')]));
  });

  it('requires at least one pupil-fill blank', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
      gates: [{ id: 'g1', type: 'AND', x: 0, y: 0, width: 80, height: 50 }],
      terminals: [],
      wires: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("'accept'")]));
  });

  it('rejects gates with both type and accept', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
      gates: [{ id: 'g1', type: 'AND', x: 0, y: 0, width: 80, height: 50, accept: ['OR'] }],
      terminals: [],
      wires: [],
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining("exactly one of 'type'")]),
    );
  });

  it('rejects gates extending past the canvas', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 300, height: 300 },
      gates: [{ id: 'g1', x: 250, y: 0, width: 80, height: 50, accept: ['AND'] }],
      terminals: [],
      wires: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining('past canvas width')]));
  });

  it('rejects duplicate ids across gates and terminals', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
      gates: [{ id: 'a', x: 100, y: 0, width: 80, height: 50, accept: ['AND'] }],
      terminals: [{ id: 'a', kind: 'input', label: 'A', x: 20, y: 20 }],
      wires: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("reuses id 'a'")]));
  });

  it('rejects wires that reference unknown ids', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
      gates: [{ id: 'g1', x: 100, y: 0, width: 80, height: 50, accept: ['AND'] }],
      terminals: [],
      wires: [{ from: 'g1', to: 'ghost' }],
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining('existing gate/terminal id')]),
    );
  });

  it('rejects terminals with unsupported kinds or long labels', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
      gates: [{ id: 'g1', x: 100, y: 0, width: 80, height: 50, accept: ['AND'] }],
      terminals: [{ id: 'x', kind: 'middle', label: 'WAY_TOO_LONG', x: 0, y: 0 }],
      wires: [],
    });
    expect(issues.some((m) => m.includes('kind'))).toBe(true);
    expect(issues.some((m) => m.includes('label'))).toBe(true);
  });
});

describe('parseLogicDiagramGatesRawAnswer / serialiseLogicDiagramGatesAnswer', () => {
  it('round-trips pupil fills keyed by gate id', () => {
    const raw = 'gout=OR';
    const parsed = parseLogicDiagramGatesRawAnswer(raw);
    expect(parsed.get('gout')).toBe('OR');
    expect(serialiseLogicDiagramGatesAnswer(GIB_CFG, parsed)).toBe(raw);
  });

  it('ignores malformed lines and prefilled gate keys', () => {
    const parsed = parseLogicDiagramGatesRawAnswer('no-equals\ngout=OR\n=orphan');
    expect(parsed.size).toBe(1);
    expect(parsed.get('gout')).toBe('OR');
  });

  it('serialiser skips prefilled and empty-fill expected gates', () => {
    const fills = new Map<string, string>([
      ['g1', 'ignored'],
      ['gout', 'OR'],
    ]);
    expect(serialiseLogicDiagramGatesAnswer(GIB_CFG, fills)).toBe('gout=OR');
  });
});

describe('markLogicDiagramGates', () => {
  it('hits when pupil answer matches accept list (case-insensitive default)', () => {
    const fills = new Map<string, string>([['gout', 'or']]);
    const result = markLogicDiagramGates(GIB_CFG, fills);
    expect(result.total).toBe(1);
    expect(result.hits).toBe(1);
    expect(result.outcomes[0]?.hit).toBe(true);
  });

  it('misses when the pupil answer is wrong or blank', () => {
    const empty = markLogicDiagramGates(GIB_CFG, new Map());
    expect(empty.hits).toBe(0);
    expect(empty.outcomes[0]?.pupilValue).toBeNull();

    const wrong = markLogicDiagramGates(GIB_CFG, new Map([['gout', 'NAND']]));
    expect(wrong.hits).toBe(0);
  });

  it('respects caseSensitive=true on a gate', () => {
    const cfg: LogicDiagramGateInBoxConfig = {
      ...GIB_CFG,
      gates: GIB_CFG.gates.map((g) =>
        g.id === 'gout' && 'accept' in g ? { ...g, accept: ['OR'], caseSensitive: true } : g,
      ),
    };
    const ok = markLogicDiagramGates(cfg, new Map([['gout', 'OR']]));
    expect(ok.outcomes[0]?.hit).toBe(true);
    const bad = markLogicDiagramGates(cfg, new Map([['gout', 'or']]));
    expect(bad.outcomes[0]?.hit).toBe(false);
  });
});

// ---------- guided_slots ----------

const SLOTS_CFG: LogicDiagramGuidedSlotsConfig = {
  variant: 'guided_slots',
  slots: [
    { id: 's1', prompt: 'Gate combining A and B', options: ['AND', 'OR', 'NOT'], accept: 'AND' },
    { id: 's2', prompt: 'Gate inverting C', options: ['AND', 'OR', 'NOT'], accept: 'NOT' },
  ],
};

describe('guided_slots validator', () => {
  it('accepts a valid config', () => {
    expect(validateLogicDiagramConfigShape(SLOTS_CFG)).toEqual([]);
    expect(isLogicDiagramConfig(SLOTS_CFG)).toBe(true);
  });

  it('requires accept to be one of options', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'guided_slots',
      slots: [{ id: 's1', prompt: 'p', options: ['A', 'B'], accept: 'C' }],
    });
    expect(issues.join('\n')).toMatch(/accept/);
  });

  it('requires at least two options', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'guided_slots',
      slots: [{ id: 's1', prompt: 'p', options: ['A'], accept: 'A' }],
    });
    expect(issues.join('\n')).toMatch(/at least two/);
  });

  it('rejects duplicate slot ids', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'guided_slots',
      slots: [
        { id: 's1', prompt: 'p', options: ['A', 'B'], accept: 'A' },
        { id: 's1', prompt: 'q', options: ['A', 'B'], accept: 'B' },
      ],
    });
    expect(issues.join('\n')).toMatch(/reuses id/);
  });

  it('rejects unexpected top-level keys', () => {
    const issues = validateLogicDiagramConfigShape({
      ...SLOTS_CFG,
      canvas: { width: 600, height: 400 },
    });
    expect(issues.join('\n')).toMatch(/unsupported key 'canvas'/);
  });
});

describe('guided_slots answers', () => {
  it('round-trips id=value lines', () => {
    const fills = new Map([
      ['s1', 'AND'],
      ['s2', 'NOT'],
    ]);
    const serialised = serialiseLogicDiagramSlotsAnswer(SLOTS_CFG, fills);
    expect(serialised).toBe('s1=AND\ns2=NOT');
    const parsed = parseLogicDiagramSlotsRawAnswer(serialised);
    expect(parsed.get('s1')).toBe('AND');
    expect(parsed.get('s2')).toBe('NOT');
  });

  it('marks one hit per correct slot (exact match)', () => {
    const result = markLogicDiagramSlots(
      SLOTS_CFG,
      new Map([
        ['s1', 'AND'],
        ['s2', 'OR'],
      ]),
    );
    expect(result.hits).toBe(1);
    expect(result.total).toBe(2);
    expect(result.outcomes[0]?.hit).toBe(true);
    expect(result.outcomes[1]?.hit).toBe(false);
  });

  it('records null for blank answers', () => {
    const result = markLogicDiagramSlots(SLOTS_CFG, new Map());
    expect(result.hits).toBe(0);
    expect(result.outcomes.every((o) => o.pupilValue === null)).toBe(true);
  });
});

// ---------- boolean_expression ----------

const BOOL_CFG: LogicDiagramBooleanExpressionConfig = {
  variant: 'boolean_expression',
  accept: ['(A AND B) OR NOT C', '(A AND B) OR (NOT C)'],
};

describe('boolean_expression validator', () => {
  it('accepts a valid config', () => {
    expect(validateLogicDiagramConfigShape(BOOL_CFG)).toEqual([]);
  });

  it('requires non-empty accept', () => {
    const issues = validateLogicDiagramConfigShape({ variant: 'boolean_expression', accept: [] });
    expect(issues.join('\n')).toMatch(/accept/);
  });

  it('validates allowedOperators entries', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'boolean_expression',
      accept: ['A'],
      allowedOperators: ['NAND'],
    });
    expect(issues.join('\n')).toMatch(/allowedOperators/);
  });

  it('rejects unexpected keys', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'boolean_expression',
      accept: ['A'],
      canvas: { width: 600, height: 400 },
    });
    expect(issues.join('\n')).toMatch(/unsupported key 'canvas'/);
  });
});

describe('tokeniseBooleanExpression', () => {
  it('splits keyword operators and identifiers', () => {
    expect(tokeniseBooleanExpression('(A AND B) OR NOT C')).toEqual([
      '(',
      'A',
      'AND',
      'B',
      ')',
      'OR',
      'NOT',
      'C',
    ]);
  });

  it('rewrites symbol operators by default', () => {
    expect(tokeniseBooleanExpression('(A.B)+/C')).toEqual([
      '(',
      'A',
      'AND',
      'B',
      ')',
      'OR',
      'NOT',
      'C',
    ]);
  });

  it('uppercases identifiers unless caseSensitive', () => {
    expect(tokeniseBooleanExpression('a and b')).toEqual(['A', 'AND', 'B']);
    expect(tokeniseBooleanExpression('a and b', { caseSensitive: true })).toEqual([
      'a',
      'and',
      'b',
    ]);
  });

  it('can leave symbols as literals when normaliseSymbols=false', () => {
    expect(tokeniseBooleanExpression('A.B', { normaliseSymbols: false })).toEqual(['A', '.', 'B']);
  });
});

describe('boolean_expression answers', () => {
  it('round-trips expression line', () => {
    const ser = serialiseLogicDiagramBooleanAnswer('(A AND B) OR NOT C');
    expect(ser).toBe('expression=(A AND B) OR NOT C');
    const parsed = parseLogicDiagramBooleanRawAnswer(ser);
    expect(parsed.expression).toBe('(A AND B) OR NOT C');
    expect(parsed.errors).toEqual([]);
  });

  it('reports unknown keys', () => {
    const parsed = parseLogicDiagramBooleanRawAnswer('foo=bar');
    expect(parsed.expression).toBeNull();
    expect(parsed.errors.join('\n')).toMatch(/unknown key/);
  });

  it('marks an exact tokenised match as a hit', () => {
    const result = markLogicDiagramBooleanExpression(BOOL_CFG, '(a AND b) OR not c');
    expect(result.hit).toBe(true);
    expect(result.matchedIndex).toBe(0);
  });

  it('accepts symbol forms when normaliseSymbols is on by default', () => {
    const result = markLogicDiagramBooleanExpression(BOOL_CFG, '(A.B)+/C');
    expect(result.hit).toBe(true);
  });

  it('rejects tokens that do not line up', () => {
    const result = markLogicDiagramBooleanExpression(BOOL_CFG, 'A AND B AND C');
    expect(result.hit).toBe(false);
    expect(result.matchedIndex).toBeNull();
  });
});

// ---------- gate_palette ----------

const PALETTE_CFG: LogicDiagramGatePaletteConfig = {
  variant: 'gate_palette',
  canvas: { width: 600, height: 400 },
  terminals: [
    { id: 'a', kind: 'input', label: 'A', x: 40, y: 80 },
    { id: 'b', kind: 'input', label: 'B', x: 40, y: 160 },
    { id: 'p', kind: 'output', label: 'P', x: 520, y: 120 },
  ],
  palette: ['AND', 'OR', 'NOT'],
  expected: {
    truthTable: [
      { inputs: { a: 0, b: 0 }, output: 0 },
      { inputs: { a: 0, b: 1 }, output: 0 },
      { inputs: { a: 1, b: 0 }, output: 0 },
      { inputs: { a: 1, b: 1 }, output: 1 },
    ],
  },
};

describe('gate_palette validator', () => {
  it('accepts a valid config', () => {
    expect(validateLogicDiagramConfigShape(PALETTE_CFG)).toEqual([]);
  });

  it('requires exactly one output terminal', () => {
    const bad = {
      ...PALETTE_CFG,
      terminals: [
        ...PALETTE_CFG.terminals,
        { id: 'q', kind: 'output', label: 'Q', x: 520, y: 200 },
      ],
    };
    const issues = validateLogicDiagramConfigShape(bad);
    expect(issues.join('\n')).toMatch(/exactly one output/);
  });

  it('requires complete truth-table coverage', () => {
    const bad = {
      ...PALETTE_CFG,
      expected: {
        truthTable: [
          { inputs: { a: 0, b: 0 }, output: 0 },
          { inputs: { a: 1, b: 1 }, output: 1 },
        ],
      },
    };
    const issues = validateLogicDiagramConfigShape(bad);
    expect(issues.join('\n')).toMatch(/cover all 4/);
  });

  it('rejects palette entries that are not gate types', () => {
    const issues = validateLogicDiagramConfigShape({ ...PALETTE_CFG, palette: ['AND', 'NAND'] });
    expect(issues.join('\n')).toMatch(/palette/);
  });
});

describe('gate_palette answers', () => {
  const correctCircuit = {
    gates: [{ id: 'g1', type: 'AND' as const }],
    wires: [
      { from: 'a', to: 'g1' },
      { from: 'b', to: 'g1' },
      { from: 'g1', to: 'p' },
    ],
  };

  it('round-trips circuit JSON', () => {
    const ser = serialiseLogicDiagramPaletteAnswer(correctCircuit);
    expect(ser.startsWith('circuit=')).toBe(true);
    const parsed = parseLogicDiagramPaletteRawAnswer(ser);
    expect(parsed.circuit?.gates).toHaveLength(1);
    expect(parsed.circuit?.wires).toHaveLength(3);
    expect(parsed.errors).toEqual([]);
  });

  it('awards the mark when every row matches', () => {
    const result = markLogicDiagramPalette(PALETTE_CFG, correctCircuit);
    expect(result.hit).toBe(true);
    expect(result.rows.every((r) => r.hit)).toBe(true);
  });

  it('fails when the circuit uses the wrong gate', () => {
    const wrong = {
      gates: [{ id: 'g1', type: 'OR' as const }],
      wires: [
        { from: 'a', to: 'g1' },
        { from: 'b', to: 'g1' },
        { from: 'g1', to: 'p' },
      ],
    };
    const result = markLogicDiagramPalette(PALETTE_CFG, wrong);
    expect(result.hit).toBe(false);
  });

  it('rejects a circuit missing the output driver', () => {
    const dangling = { gates: [{ id: 'g1', type: 'AND' as const }], wires: [] };
    const result = markLogicDiagramPalette(PALETTE_CFG, dangling);
    expect(result.hit).toBe(false);
    expect(result.rows.every((r) => r.actual === null)).toBe(true);
  });

  it('rejects a cyclic circuit', () => {
    const cyclic = {
      gates: [
        { id: 'g1', type: 'AND' as const },
        { id: 'g2', type: 'OR' as const },
      ],
      wires: [
        { from: 'a', to: 'g1' },
        { from: 'g2', to: 'g1' },
        { from: 'b', to: 'g2' },
        { from: 'g1', to: 'g2' },
        { from: 'g1', to: 'p' },
      ],
    };
    const result = markLogicDiagramPalette(PALETTE_CFG, cyclic);
    expect(result.hit).toBe(false);
  });

  it('reports malformed JSON payloads', () => {
    const parsed = parseLogicDiagramPaletteRawAnswer('circuit=not json');
    expect(parsed.circuit).toBeNull();
    expect(parsed.errors.join('\n')).toMatch(/valid JSON/);
  });

  it('returns a miss with null actuals for an empty answer', () => {
    const result = markLogicDiagramPalette(PALETTE_CFG, null);
    expect(result.hit).toBe(false);
    expect(result.rows).toHaveLength(4);
  });
});
