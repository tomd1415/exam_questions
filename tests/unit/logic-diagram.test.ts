import { describe, it, expect } from 'vitest';
import {
  LOGIC_DIAGRAM_DATA_URL_PREFIX,
  MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH,
  isLogicDiagramConfig,
  parseLogicDiagramRawAnswer,
  serialiseLogicDiagramAnswer,
  validateLogicDiagramConfigShape,
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

  it('rejects unsupported variants (Phase 3 placeholders not yet enabled)', () => {
    const issues = validateLogicDiagramConfigShape({
      variant: 'gate_in_box',
      canvas: { width: 600, height: 400 },
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining("variant 'gate_in_box'")]),
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
