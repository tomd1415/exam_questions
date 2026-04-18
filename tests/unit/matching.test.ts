import { describe, it, expect } from 'vitest';
import {
  isMatchingConfig,
  markMatching,
  parseMatchingRawAnswer,
  serialiseMatchingAnswer,
  validateMatchingConfigShape,
  type MatchingConfig,
} from '../../src/lib/matching.js';

function cfg(overrides: Partial<MatchingConfig> = {}): MatchingConfig {
  return {
    left: ['HTTP', 'SMTP'],
    right: ['web', 'email', 'remote shell'],
    correctPairs: [
      [0, 0],
      [1, 1],
    ],
    ...overrides,
  };
}

describe('validateMatchingConfigShape', () => {
  it('accepts a minimal valid config', () => {
    expect(validateMatchingConfigShape(cfg())).toEqual([]);
  });

  it('requires left, right, correctPairs', () => {
    expect(validateMatchingConfigShape({})).toEqual(
      expect.arrayContaining([
        expect.stringContaining('left'),
        expect.stringContaining('right'),
        expect.stringContaining('correctPairs'),
      ]),
    );
  });

  it('rejects right shorter than left', () => {
    const issues = validateMatchingConfigShape({
      left: ['a', 'b', 'c'],
      right: ['x', 'y'],
      correctPairs: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    });
    expect(issues.some((m) => m.includes('at least as many'))).toBe(true);
  });

  it('rejects duplicate left prompts', () => {
    const issues = validateMatchingConfigShape(cfg({ left: ['HTTP', 'HTTP'] }));
    expect(issues.some((m) => m.includes('left'))).toBe(true);
  });

  it('rejects duplicate right options', () => {
    const issues = validateMatchingConfigShape(cfg({ right: ['web', 'web', 'email'] }));
    expect(issues.some((m) => m.includes('right'))).toBe(true);
  });

  it('rejects correctPairs with out-of-range indices', () => {
    const issues = validateMatchingConfigShape(
      cfg({
        correctPairs: [
          [0, 0],
          [1, 9],
        ],
      }),
    );
    expect(issues.some((m) => m.includes('out of range'))).toBe(true);
  });

  it('rejects correctPairs that reuse a left index', () => {
    const issues = validateMatchingConfigShape(
      cfg({
        correctPairs: [
          [0, 0],
          [0, 1],
        ],
      }),
    );
    expect(issues.some((m) => m.includes('reuses leftIndex'))).toBe(true);
  });

  it('rejects correctPairs whose length differs from left', () => {
    const issues = validateMatchingConfigShape(cfg({ correctPairs: [[0, 0]] }));
    expect(issues.some((m) => m.includes('exactly one entry'))).toBe(true);
  });

  it('allows a right index to be shared across multiple pairs', () => {
    // E.g. two protocols that belong to the same layer.
    const issues = validateMatchingConfigShape({
      left: ['HTTP', 'HTTPS'],
      right: ['application layer', 'transport layer'],
      correctPairs: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(issues).toEqual([]);
  });

  it('rejects extra top-level keys', () => {
    const c = { ...cfg(), surprise: true } as unknown;
    expect(validateMatchingConfigShape(c).some((m) => m.includes('surprise'))).toBe(true);
  });

  it('isMatchingConfig is the type-guard form', () => {
    expect(isMatchingConfig(cfg())).toBe(true);
    expect(isMatchingConfig(null)).toBe(false);
  });
});

describe('parseMatchingRawAnswer / serialiseMatchingAnswer', () => {
  it('round-trips L=R lines, ignoring blanks and malformed lines', () => {
    const raw = '0=0\n1=1\nbroken\n=ignored\n2=\nz=1\n';
    const parsed = parseMatchingRawAnswer(raw);
    expect(parsed.get(0)).toBe(0);
    expect(parsed.get(1)).toBe(1);
    expect(parsed.size).toBe(2);
    expect(serialiseMatchingAnswer(parsed)).toBe('0=0\n1=1');
  });

  it('preserves the last value when a left row is repeated', () => {
    const parsed = parseMatchingRawAnswer('0=0\n0=1');
    expect(parsed.get(0)).toBe(1);
  });
});

describe('markMatching', () => {
  it('all-correct: every outcome hits', () => {
    const r = markMatching(
      cfg(),
      new Map([
        [0, 0],
        [1, 1],
      ]),
    );
    expect(r.hits).toBe(2);
    expect(r.outcomes.every((o) => o.hit)).toBe(true);
  });

  it('a wrong pick on one row hits only the remaining row', () => {
    const r = markMatching(
      cfg(),
      new Map([
        [0, 0],
        [1, 2],
      ]),
    );
    expect(r.hits).toBe(1);
    expect(r.outcomes[0]!.hit).toBe(true);
    expect(r.outcomes[1]!.hit).toBe(false);
    expect(r.outcomes[1]!.pickedRight).toBe(2);
  });

  it('an out-of-range right index is reported as picked but scores zero', () => {
    const r = markMatching(
      cfg(),
      new Map([
        [0, 0],
        [1, 99],
      ]),
    );
    expect(r.hits).toBe(1);
    expect(r.outcomes[1]!.hit).toBe(false);
    expect(r.outcomes[1]!.pickedRight).toBe(99);
  });

  it('unpaired left rows score zero (no negative marks)', () => {
    const r = markMatching(cfg(), new Map([[0, 0]]));
    expect(r.hits).toBe(1);
    expect(r.outcomes[1]!.hit).toBe(false);
    expect(r.outcomes[1]!.pickedRight).toBeNull();
  });

  it('distractor targets never pair up', () => {
    const r = markMatching(
      cfg(),
      new Map([
        [0, 2],
        [1, 2],
      ]),
    ); // right[2] is distractor
    expect(r.hits).toBe(0);
  });

  it('a shared-right config scores both rows correctly when each picks it', () => {
    const c: MatchingConfig = {
      left: ['HTTP', 'HTTPS'],
      right: ['application', 'transport'],
      correctPairs: [
        [0, 0],
        [1, 0],
      ],
    };
    const r = markMatching(
      c,
      new Map([
        [0, 0],
        [1, 0],
      ]),
    );
    expect(r.hits).toBe(2);
  });
});
