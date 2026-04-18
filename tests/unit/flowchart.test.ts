import { describe, it, expect } from 'vitest';
import {
  FLOWCHART_DATA_URL_PREFIX,
  MAX_FLOWCHART_DATA_URL_LENGTH,
  isFlowchartConfig,
  parseFlowchartRawAnswer,
  serialiseFlowchartAnswer,
  validateFlowchartConfigShape,
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

  it('rejects unsupported variants (shape palette deferred to Phase 3)', () => {
    const issues = validateFlowchartConfigShape({
      variant: 'shapes',
      canvas: { width: 600, height: 500 },
    });
    expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("variant 'shapes'")]));
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
