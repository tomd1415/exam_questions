import { describe, it, expect } from 'vitest';
import {
  coordKey,
  generateTruthTablePrefill,
  isTraceGridConfig,
  markTraceGrid,
  parseTraceGridRawAnswer,
  serialiseTraceGridAnswer,
  validateTraceGridConfigShape,
  type TraceGridConfig,
} from '../../src/lib/trace-grid.js';

function cfg(overrides: Partial<TraceGridConfig> = {}): TraceGridConfig {
  return {
    columns: [{ name: 'i' }, { name: 'total' }],
    rows: 2,
    expected: { '0,1': '2', '1,1': '6' },
    marking: { mode: 'perCell' },
    ...overrides,
  };
}

describe('validateTraceGridConfigShape', () => {
  it('accepts a minimal valid config', () => {
    expect(validateTraceGridConfigShape(cfg())).toEqual([]);
  });

  it('requires columns, rows, expected, marking', () => {
    expect(validateTraceGridConfigShape({})).toEqual(
      expect.arrayContaining([
        expect.stringContaining('columns'),
        expect.stringContaining('rows'),
        expect.stringContaining('expected'),
        expect.stringContaining('marking'),
      ]),
    );
  });

  it('rejects coords outside the grid', () => {
    const issues = validateTraceGridConfigShape(cfg({ expected: { '0,1': '2', '5,1': '?' } }));
    expect(issues.some((m) => m.includes('out of range'))).toBe(true);
  });

  it('rejects a coord that is both prefilled and expected', () => {
    const issues = validateTraceGridConfigShape(
      cfg({ prefill: { '0,1': '?' }, expected: { '0,1': '2', '1,1': '6' } }),
    );
    expect(issues.some((m) => m.includes('both prefill and expected'))).toBe(true);
  });

  it('rejects unsupported marking modes', () => {
    const issues = validateTraceGridConfigShape(cfg({ marking: { mode: 'random' as 'perCell' } }));
    expect(issues.some((m) => m.includes('marking.mode'))).toBe(true);
  });

  it('rejects extra top-level keys', () => {
    const c = { ...cfg(), surprise: true } as unknown;
    expect(validateTraceGridConfigShape(c).some((m) => m.includes('surprise'))).toBe(true);
  });

  it('rejects duplicate column names', () => {
    expect(
      validateTraceGridConfigShape(cfg({ columns: [{ name: 'i' }, { name: 'i' }] })).some((m) =>
        m.includes('duplicated'),
      ),
    ).toBe(true);
  });

  it('isTraceGridConfig is the type-guard form', () => {
    expect(isTraceGridConfig(cfg())).toBe(true);
    expect(isTraceGridConfig(null)).toBe(false);
  });
});

describe('parseTraceGridRawAnswer / serialiseTraceGridAnswer', () => {
  it('round-trips r,c=value lines, ignoring blanks and malformed lines', () => {
    const raw = '0,1=2\n1,1=6\nbroken\n=ignored\n2,3=\n';
    const parsed = parseTraceGridRawAnswer(raw);
    expect(parsed.get('0,1')).toBe('2');
    expect(parsed.get('1,1')).toBe('6');
    expect(parsed.size).toBe(2);
    expect(serialiseTraceGridAnswer(parsed)).toBe('0,1=2\n1,1=6');
  });

  it('preserves the last value when a coord is repeated', () => {
    const parsed = parseTraceGridRawAnswer('0,0=first\n0,0=second');
    expect(parsed.get('0,0')).toBe('second');
  });
});

describe('markTraceGrid', () => {
  it('perCell: each correct cell scores once', () => {
    const r = markTraceGrid(
      cfg(),
      new Map([
        ['0,1', '2'],
        ['1,1', '6'],
      ]),
    );
    expect(r.hits).toBe(2);
    expect(r.outcomes.every((o) => o.hit)).toBe(true);
  });

  it('perCell: ignores case and surrounding whitespace by default', () => {
    const r = markTraceGrid(
      cfg({ expected: { '0,1': 'TRUE', '1,1': 'False' } }),
      new Map([
        ['0,1', '  true '],
        ['1,1', 'FALSE'],
      ]),
    );
    expect(r.hits).toBe(2);
  });

  it('perCell: caseSensitive=true distinguishes cases', () => {
    const r = markTraceGrid(
      cfg({
        expected: { '0,1': 'X', '1,1': 'Y' },
        marking: { mode: 'perCell', caseSensitive: true },
      }),
      new Map([
        ['0,1', 'x'],
        ['1,1', 'Y'],
      ]),
    );
    expect(r.hits).toBe(1);
  });

  it('perRow: a row with one wrong cell awards 0 for that row', () => {
    const c = cfg({
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      rows: 2,
      expected: { '0,0': '1', '0,1': '2', '1,0': '3', '1,1': '4' },
      marking: { mode: 'perRow' },
    });
    const r = markTraceGrid(
      c,
      new Map([
        ['0,0', '1'],
        ['0,1', '2'],
        ['1,0', '3'],
        ['1,1', 'WRONG'],
      ]),
    );
    expect(r.hits).toBe(2); // row 0 fully correct (2 cells), row 1 not
  });

  it('allOrNothing: misses zero out everything', () => {
    const r = markTraceGrid(
      cfg({ marking: { mode: 'allOrNothing' } }),
      new Map([
        ['0,1', '2'],
        ['1,1', 'WRONG'],
      ]),
    );
    expect(r.hits).toBe(0);
  });

  it('allOrNothing: full grid scores total', () => {
    const r = markTraceGrid(
      cfg({ marking: { mode: 'allOrNothing' } }),
      new Map([
        ['0,1', '2'],
        ['1,1', '6'],
      ]),
    );
    expect(r.hits).toBe(2);
  });

  it('cells the pupil leaves blank score zero (no negative marks)', () => {
    const r = markTraceGrid(cfg(), new Map([['0,1', '2']]));
    expect(r.hits).toBe(1);
  });

  it('extra cells outside expected are ignored', () => {
    const r = markTraceGrid(
      cfg(),
      new Map([
        ['0,1', '2'],
        ['1,1', '6'],
        ['9,9', 'junk'],
      ]),
    );
    expect(r.hits).toBe(2);
    expect(r.outcomes.every((o) => o.r < 2)).toBe(true);
  });
});

describe('generateTruthTablePrefill', () => {
  it('produces 2ⁿ rows in big-endian order', () => {
    const { prefill, rows } = generateTruthTablePrefill(['A', 'B']);
    expect(rows).toBe(4);
    // Big-endian: leftmost variable is the most significant bit.
    expect(prefill[coordKey(0, 0)]).toBe('0');
    expect(prefill[coordKey(0, 1)]).toBe('0');
    expect(prefill[coordKey(1, 0)]).toBe('0');
    expect(prefill[coordKey(1, 1)]).toBe('1');
    expect(prefill[coordKey(2, 0)]).toBe('1');
    expect(prefill[coordKey(2, 1)]).toBe('0');
    expect(prefill[coordKey(3, 0)]).toBe('1');
    expect(prefill[coordKey(3, 1)]).toBe('1');
  });

  it('handles 3 variables (8 rows) and 1 variable (2 rows)', () => {
    expect(generateTruthTablePrefill(['A']).rows).toBe(2);
    expect(generateTruthTablePrefill(['A', 'B', 'C']).rows).toBe(8);
  });

  it('rejects 0 or >4 variables and duplicates and blanks', () => {
    expect(() => generateTruthTablePrefill([])).toThrow();
    expect(() => generateTruthTablePrefill(['A', 'B', 'C', 'D', 'E'])).toThrow();
    expect(() => generateTruthTablePrefill(['A', 'A'])).toThrow();
    expect(() => generateTruthTablePrefill([''])).toThrow();
  });

  it('the generated prefill shapes a valid truth-table config when paired with output expected cells', () => {
    const { prefill, rows } = generateTruthTablePrefill(['A', 'B']);
    const config: TraceGridConfig = {
      columns: [{ name: 'A' }, { name: 'B' }, { name: 'A AND B' }],
      rows,
      prefill,
      // Author fills these in: AND truth table.
      expected: { '0,2': '0', '1,2': '0', '2,2': '0', '3,2': '1' },
      marking: { mode: 'perCell' },
    };
    expect(validateTraceGridConfigShape(config)).toEqual([]);
  });
});
