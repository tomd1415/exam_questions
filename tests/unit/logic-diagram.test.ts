import { describe, it, expect } from 'vitest';
import {
  LOGIC_DIAGRAM_DATA_URL_PREFIX,
  MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH,
  isLogicDiagramConfig,
  markLogicDiagramGates,
  parseLogicDiagramGatesRawAnswer,
  parseLogicDiagramRawAnswer,
  serialiseLogicDiagramAnswer,
  serialiseLogicDiagramGatesAnswer,
  validateLogicDiagramConfigShape,
  type LogicDiagramGateInBoxConfig,
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

  it('rejects unsupported variants (Phase 3 placeholder structured_free not yet enabled)', () => {
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
