import { describe, it, expect } from 'vitest';
import {
  FLOWCHART_DATA_URL_PREFIX,
  MAX_FLOWCHART_DATA_URL_LENGTH,
  isFlowchartConfig,
  markFlowchartShapes,
  parseFlowchartRawAnswer,
  parseFlowchartShapesRawAnswer,
  serialiseFlowchartAnswer,
  serialiseFlowchartShapesAnswer,
  validateFlowchartConfigShape,
  type FlowchartShapesConfig,
} from '../../src/lib/flowchart.js';

const VALID_PNG = `${FLOWCHART_DATA_URL_PREFIX}iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=`;

describe('validateFlowchartConfigShape', () => {
  it('accepts a minimal valid config', () => {
    expect(
      validateFlowchartConfigShape({ variant: 'image', canvas: { width: 600, height: 500 } }),
    ).toEqual([]);
  });

  it('requires variant', () => {
    expect(validateFlowchartConfigShape({ canvas: { width: 600, height: 500 } })).toEqual(
      expect.arrayContaining([expect.stringContaining('variant')]),
    );
  });

  it('rejects unsupported variants', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'freeform',
      canvas: { width: 600, height: 500 },
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("variant 'freeform'")]));
  });

  it('requires canvas with width and height', () => {
    expect(validateFlowchartConfigShape({ variant: 'image' })).toEqual(
      expect.arrayContaining([expect.stringContaining('canvas')]),
    );
    expect(validateFlowchartConfigShape({ variant: 'image', canvas: { width: 600 } })).toEqual(
      expect.arrayContaining([expect.stringContaining('height')]),
    );
  });

  it('clamps canvas dimensions to a sensible range', () => {
    expect(
      validateFlowchartConfigShape({ variant: 'image', canvas: { width: 50, height: 500 } }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('width')]));
    expect(
      validateFlowchartConfigShape({ variant: 'image', canvas: { width: 600, height: 5000 } }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('height')]));
  });

  it('rejects unknown top-level or canvas keys', () => {
    expect(
      validateFlowchartConfigShape({
        variant: 'image',
        canvas: { width: 600, height: 500 },
        palette: ['process'],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("'palette'")]));
    expect(
      validateFlowchartConfigShape({
        variant: 'image',
        canvas: { width: 600, height: 500, depth: 1 },
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("'depth'")]));
  });

  it('isFlowchartConfig matches validateFlowchartConfigShape', () => {
    expect(isFlowchartConfig({ variant: 'image', canvas: { width: 200, height: 200 } })).toBe(true);
    expect(isFlowchartConfig({ variant: 'image' })).toBe(false);
  });
});

describe('parseFlowchartRawAnswer', () => {
  it('returns null for an empty string', () => {
    expect(parseFlowchartRawAnswer('')).toEqual({ image: null, errors: [] });
  });

  it('parses a single image= line into a data URL', () => {
    const out = parseFlowchartRawAnswer(`image=${VALID_PNG}`);
    expect(out.image).toBe(VALID_PNG);
    expect(out.errors).toEqual([]);
  });

  it('rejects non-PNG data URLs', () => {
    const out = parseFlowchartRawAnswer('image=data:image/svg+xml;base64,PHN2Zy8+');
    expect(out.image).toBeNull();
    expect(out.errors[0]).toContain(FLOWCHART_DATA_URL_PREFIX);
  });

  it('rejects malformed base64 payloads', () => {
    const out = parseFlowchartRawAnswer(`image=${FLOWCHART_DATA_URL_PREFIX}!!!not base64!!!`);
    expect(out.image).toBeNull();
    expect(out.errors.some((e) => e.includes('base64'))).toBe(true);
  });

  it('rejects oversized payloads', () => {
    const huge = 'A'.repeat(MAX_FLOWCHART_DATA_URL_LENGTH + 1);
    const out = parseFlowchartRawAnswer(`image=${FLOWCHART_DATA_URL_PREFIX}${huge}`);
    expect(out.image).toBeNull();
    expect(out.errors.some((e) => e.includes('exceeds'))).toBe(true);
  });

  it('flags unknown keys but keeps the image', () => {
    const out = parseFlowchartRawAnswer(`notes=hello\nimage=${VALID_PNG}`);
    expect(out.image).toBe(VALID_PNG);
    expect(out.errors.some((e) => e.includes("'notes'"))).toBe(true);
  });
});

describe('serialiseFlowchartAnswer', () => {
  it('returns "" for null/empty', () => {
    expect(serialiseFlowchartAnswer(null)).toBe('');
    expect(serialiseFlowchartAnswer('')).toBe('');
  });

  it('round-trips with the parser', () => {
    const out = serialiseFlowchartAnswer(VALID_PNG);
    expect(out).toBe(`image=${VALID_PNG}`);
    expect(parseFlowchartRawAnswer(out).image).toBe(VALID_PNG);
  });
});

// ---------------------------------------------------------------------------
// Shapes variant (chunk 2.5k)
// ---------------------------------------------------------------------------

const SHAPES_CFG: FlowchartShapesConfig = {
  variant: 'shapes',
  canvas: { width: 600, height: 400 },
  shapes: [
    { id: 'start', type: 'terminator', x: 220, y: 20, width: 160, height: 50, text: 'Start' },
    { id: 'q1', type: 'decision', x: 200, y: 100, width: 200, height: 80, text: 'Is A > B?' },
    {
      id: 'out_a',
      type: 'io',
      x: 60,
      y: 220,
      width: 180,
      height: 50,
      accept: ['Output A', 'Print A'],
    },
    { id: 'out_b', type: 'io', x: 360, y: 220, width: 180, height: 50, accept: ['Output B'] },
    { id: 'stop', type: 'terminator', x: 220, y: 310, width: 160, height: 50, text: 'Stop' },
  ],
  arrows: [
    { from: 'start', to: 'q1' },
    { from: 'q1', to: 'out_a', label: 'Yes' },
    { from: 'q1', to: 'out_b', label: 'No' },
    { from: 'out_a', to: 'stop' },
    { from: 'out_b', to: 'stop' },
  ],
};

describe('validateFlowchartConfigShape (shapes variant)', () => {
  it('accepts a valid shapes config', () => {
    expect(validateFlowchartConfigShape(SHAPES_CFG)).toEqual([]);
  });

  it('requires shapes to be a non-empty array', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 600, height: 400 },
      shapes: [],
      arrows: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining('shapes')]));
  });

  it('requires at least one pupil-fill shape', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 600, height: 400 },
      shapes: [{ id: 'a', type: 'process', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      arrows: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("'accept'")]));
  });

  it('rejects shapes with both text and accept', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 600, height: 400 },
      shapes: [
        {
          id: 'a',
          type: 'process',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: 'x',
          accept: ['y'],
        },
      ],
      arrows: [],
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining("exactly one of 'text'")]),
    );
  });

  it('rejects shapes extending past the canvas', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 300, height: 300 },
      shapes: [{ id: 'a', type: 'process', x: 250, y: 0, width: 100, height: 50, accept: ['hi'] }],
      arrows: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining('past canvas width')]));
  });

  it('rejects duplicate shape ids', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 600, height: 400 },
      shapes: [
        { id: 'a', type: 'process', x: 0, y: 0, width: 100, height: 50, accept: ['x'] },
        { id: 'a', type: 'process', x: 0, y: 60, width: 100, height: 50, accept: ['y'] },
      ],
      arrows: [],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("reuses id 'a'")]));
  });

  it('rejects arrows that reference unknown shapes', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 600, height: 400 },
      shapes: [{ id: 'a', type: 'process', x: 0, y: 0, width: 100, height: 50, accept: ['x'] }],
      arrows: [{ from: 'a', to: 'ghost' }],
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining('existing shape id')]));
  });
});

describe('parseFlowchartShapesRawAnswer / serialiseFlowchartShapesAnswer', () => {
  it('round-trips pupil fills keyed by shape id', () => {
    const raw = 'out_a=Print A\nout_b=Output B';
    const parsed = parseFlowchartShapesRawAnswer(raw);
    expect(parsed.get('out_a')).toBe('Print A');
    expect(parsed.get('out_b')).toBe('Output B');
    expect(serialiseFlowchartShapesAnswer(SHAPES_CFG, parsed)).toBe(raw);
  });

  it('ignores malformed lines and prefilled shape keys', () => {
    const parsed = parseFlowchartShapesRawAnswer('no-equals-sign\nout_a=hello\n=orphan');
    expect(parsed.size).toBe(1);
    expect(parsed.get('out_a')).toBe('hello');
  });

  it('serialiser skips prefilled and empty-fill expected shapes', () => {
    const fills = new Map<string, string>([
      ['start', 'ignored'],
      ['out_a', 'Print A'],
    ]);
    expect(serialiseFlowchartShapesAnswer(SHAPES_CFG, fills)).toBe('out_a=Print A');
  });
});

describe('markFlowchartShapes', () => {
  it('hits when pupil answers match the accept list (case-insensitive default)', () => {
    const fills = new Map<string, string>([
      ['out_a', 'print a'],
      ['out_b', 'OUTPUT B'],
    ]);
    const result = markFlowchartShapes(SHAPES_CFG, fills);
    expect(result.total).toBe(2);
    expect(result.hits).toBe(2);
    expect(result.outcomes.every((o) => o.hit)).toBe(true);
  });

  it('misses when the pupil answer is wrong or blank', () => {
    const fills = new Map<string, string>([['out_a', 'nope']]);
    const result = markFlowchartShapes(SHAPES_CFG, fills);
    expect(result.total).toBe(2);
    expect(result.hits).toBe(0);
    expect(result.outcomes.find((o) => o.shapeId === 'out_b')?.pupilValue).toBeNull();
  });

  it('respects caseSensitive=true on a shape', () => {
    const cfg: FlowchartShapesConfig = {
      ...SHAPES_CFG,
      shapes: SHAPES_CFG.shapes.map((s) =>
        s.id === 'out_a' ? { ...s, accept: ['Output A'], caseSensitive: true } : s,
      ),
    };
    const ok = markFlowchartShapes(cfg, new Map([['out_a', 'Output A']]));
    expect(ok.outcomes.find((o) => o.shapeId === 'out_a')?.hit).toBe(true);
    const bad = markFlowchartShapes(cfg, new Map([['out_a', 'output a']]));
    expect(bad.outcomes.find((o) => o.shapeId === 'out_a')?.hit).toBe(false);
  });
});
