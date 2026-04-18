import { describe, it, expect } from 'vitest';
import {
  isDiagramLabelsConfig,
  markDiagramLabels,
  parseDiagramLabelsRawAnswer,
  serialiseDiagramLabelsAnswer,
  validateDiagramLabelsConfigShape,
  type DiagramLabelsConfig,
} from '../../src/lib/diagram-labels.js';

function cfg(overrides: Partial<DiagramLabelsConfig> = {}): DiagramLabelsConfig {
  return {
    imageUrl: '/static/curated/network-topology-star.svg',
    imageAlt: 'Star topology',
    width: 600,
    height: 360,
    hotspots: [
      { id: 'centre', x: 240, y: 150, width: 120, height: 60, accept: ['switch', 'hub'] },
      { id: 'host-1', x: 40, y: 30, width: 120, height: 60, accept: ['client', 'host'] },
    ],
    ...overrides,
  };
}

describe('validateDiagramLabelsConfigShape', () => {
  it('accepts a minimal valid config', () => {
    expect(validateDiagramLabelsConfigShape(cfg())).toEqual([]);
  });

  it('requires imageUrl/imageAlt/width/height/hotspots', () => {
    expect(validateDiagramLabelsConfigShape({})).toEqual(
      expect.arrayContaining([
        expect.stringContaining('imageUrl'),
        expect.stringContaining('imageAlt'),
        expect.stringContaining('width'),
        expect.stringContaining('height'),
        expect.stringContaining('hotspots'),
      ]),
    );
  });

  it('rejects http:// and other unapproved imageUrls', () => {
    expect(validateDiagramLabelsConfigShape(cfg({ imageUrl: 'http://example.com/i.png' }))).toEqual(
      expect.arrayContaining([expect.stringContaining('imageUrl')]),
    );
    expect(validateDiagramLabelsConfigShape(cfg({ imageUrl: 'foo.png' }))).toEqual(
      expect.arrayContaining([expect.stringContaining('imageUrl')]),
    );
  });

  it('accepts https:// and /static/ imageUrls', () => {
    expect(
      validateDiagramLabelsConfigShape(cfg({ imageUrl: 'https://cdn.example.com/x.svg' })),
    ).toEqual([]);
  });

  it('rejects hotspots that overflow the image', () => {
    expect(
      validateDiagramLabelsConfigShape(
        cfg({
          hotspots: [{ id: 'overflow', x: 590, y: 0, width: 100, height: 60, accept: ['x'] }],
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('past image width')]));
  });

  it('rejects duplicate hotspot ids', () => {
    expect(
      validateDiagramLabelsConfigShape(
        cfg({
          hotspots: [
            { id: 'a', x: 0, y: 0, width: 50, height: 50, accept: ['x'] },
            { id: 'a', x: 60, y: 0, width: 50, height: 50, accept: ['x'] },
          ],
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("'a'")]));
  });

  it('rejects empty accept lists', () => {
    expect(
      validateDiagramLabelsConfigShape(
        cfg({
          hotspots: [{ id: 'a', x: 0, y: 0, width: 50, height: 50, accept: [] }],
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('accept')]));
  });

  it('isDiagramLabelsConfig matches validateDiagramLabelsConfigShape', () => {
    expect(isDiagramLabelsConfig(cfg())).toBe(true);
    expect(isDiagramLabelsConfig({ imageUrl: 'foo' })).toBe(false);
  });
});

describe('parseDiagramLabelsRawAnswer', () => {
  it('returns an empty map for the empty string', () => {
    expect(parseDiagramLabelsRawAnswer('')).toEqual(new Map());
  });

  it('parses well-formed lines into a Map', () => {
    const m = parseDiagramLabelsRawAnswer('centre=Switch\nhost-1=client');
    expect(m.get('centre')).toBe('Switch');
    expect(m.get('host-1')).toBe('client');
  });

  it('ignores lines whose key fails the id regex', () => {
    const m = parseDiagramLabelsRawAnswer('centre=Switch\nbad key=oops');
    expect(m.has('centre')).toBe(true);
    expect(m.size).toBe(1);
  });
});

describe('serialiseDiagramLabelsAnswer', () => {
  it('emits id=value lines in hotspot order, skipping blanks', () => {
    const config = cfg();
    const labels = new Map([['host-1', 'client']]);
    expect(serialiseDiagramLabelsAnswer(config, labels)).toBe('host-1=client');
  });

  it('round-trips through the parser', () => {
    const config = cfg();
    const labels = new Map([
      ['centre', 'switch'],
      ['host-1', 'client'],
    ]);
    const out = serialiseDiagramLabelsAnswer(config, labels);
    expect(out).toBe('centre=switch\nhost-1=client');
    expect(parseDiagramLabelsRawAnswer(out)).toEqual(labels);
  });
});

describe('markDiagramLabels', () => {
  it('hits when a pupil label matches accept (case-insensitive by default)', () => {
    const r = markDiagramLabels(cfg(), new Map([['centre', 'SWITCH']]));
    const centre = r.outcomes.find((o) => o.hotspotId === 'centre');
    expect(centre?.hit).toBe(true);
    expect(r.hits).toBe(1);
    expect(r.total).toBe(2);
  });

  it('respects caseSensitive=true', () => {
    const c = cfg({
      hotspots: [
        {
          id: 'centre',
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          accept: ['Switch'],
          caseSensitive: true,
        },
      ],
    });
    expect(markDiagramLabels(c, new Map([['centre', 'switch']])).hits).toBe(0);
    expect(markDiagramLabels(c, new Map([['centre', 'Switch']])).hits).toBe(1);
  });

  it('trims whitespace by default; preserves it when trimWhitespace=false', () => {
    const trimmed = cfg({
      hotspots: [{ id: 'a', x: 0, y: 0, width: 50, height: 50, accept: ['hub'] }],
    });
    expect(markDiagramLabels(trimmed, new Map([['a', '  hub  ']])).hits).toBe(1);

    const literal = cfg({
      hotspots: [
        { id: 'a', x: 0, y: 0, width: 50, height: 50, accept: ['hub'], trimWhitespace: false },
      ],
    });
    expect(markDiagramLabels(literal, new Map([['a', '  hub  ']])).hits).toBe(0);
  });

  it('blank/missing hotspot never hits', () => {
    const r = markDiagramLabels(cfg(), new Map([['centre', '']]));
    const centre = r.outcomes.find((o) => o.hotspotId === 'centre');
    expect(centre?.hit).toBe(false);
    expect(r.hits).toBe(0);
  });
});
