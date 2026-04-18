import { describe, it, expect } from 'vitest';
import {
  ClozeParseError,
  gapIdsFromText,
  isClozeConfig,
  isClozeWithBankConfig,
  markCloze,
  parseClozeRawAnswer,
  parseClozeText,
  summariseCloze,
  validateClozeConfigShape,
  type ClozeConfig,
} from '../../src/lib/cloze.js';

describe('parseClozeText', () => {
  it('returns the whole string as one text segment when there are no gaps', () => {
    const segs = parseClozeText('Plain prose with no gaps.');
    expect(segs).toEqual([{ kind: 'text', text: 'Plain prose with no gaps.' }]);
  });

  it('parses a single gap mid-sentence', () => {
    const segs = parseClozeText('A {{x}} thing.');
    expect(segs).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'gap', id: 'x' },
      { kind: 'text', text: ' thing.' },
    ]);
  });

  it('parses multiple gaps and back-to-back gaps', () => {
    const segs = parseClozeText('{{a}} and {{b}}{{c}}.');
    expect(segs).toEqual([
      { kind: 'gap', id: 'a' },
      { kind: 'text', text: ' and ' },
      { kind: 'gap', id: 'b' },
      { kind: 'gap', id: 'c' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('honours \\{{ and \\}} as escapes that pass literal braces through', () => {
    const segs = parseClozeText('Use \\{{double braces\\}} to escape.');
    expect(segs).toEqual([{ kind: 'text', text: 'Use {{double braces}} to escape.' }]);
  });

  it('throws on an unclosed gap marker', () => {
    expect(() => parseClozeText('Bad {{open and stop')).toThrow(ClozeParseError);
  });

  it('throws on an empty gap id', () => {
    expect(() => parseClozeText('Hi {{ }} there')).toThrow(ClozeParseError);
  });

  it('throws when the gap id contains illegal characters', () => {
    expect(() => parseClozeText('No {{a b}} please')).toThrow(ClozeParseError);
    expect(() => parseClozeText('No {{a.b}} either')).toThrow(ClozeParseError);
  });

  it('trims surrounding whitespace inside the marker', () => {
    expect(parseClozeText('A {{  spaced-id  }} mark')).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'gap', id: 'spaced-id' },
      { kind: 'text', text: ' mark' },
    ]);
  });
});

describe('gapIdsFromText', () => {
  it('returns gap ids in document order', () => {
    expect(gapIdsFromText('{{c}} {{a}} {{b}}')).toEqual(['c', 'a', 'b']);
  });
});

describe('validateClozeConfigShape / isClozeConfig', () => {
  function ok(extra?: Partial<ClozeConfig>): ClozeConfig {
    return {
      text: 'Two and two is {{sum}}.',
      gaps: [{ id: 'sum', accept: ['four', '4'] }],
      ...(extra ?? {}),
    };
  }

  it('accepts a minimal valid free-cloze config', () => {
    expect(validateClozeConfigShape(ok(), { requireBank: false })).toEqual([]);
    expect(isClozeConfig(ok())).toBe(true);
  });

  it('rejects null / non-objects / arrays', () => {
    expect(validateClozeConfigShape(null, { requireBank: false }).length).toBeGreaterThan(0);
    expect(validateClozeConfigShape('text', { requireBank: false }).length).toBeGreaterThan(0);
    expect(validateClozeConfigShape([], { requireBank: false }).length).toBeGreaterThan(0);
  });

  it('rejects when text is missing or empty', () => {
    expect(validateClozeConfigShape({ gaps: [] }, { requireBank: false }).length).toBeGreaterThan(
      0,
    );
    expect(
      validateClozeConfigShape({ text: '', gaps: [] }, { requireBank: false }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects when text has no gaps at all', () => {
    expect(
      validateClozeConfigShape({ text: 'no gaps here', gaps: [] }, { requireBank: false }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects when gaps is missing or empty', () => {
    expect(
      validateClozeConfigShape({ text: 'A {{x}}.', gaps: [] }, { requireBank: false }).length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape({ text: 'A {{x}}.' }, { requireBank: false }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects when text references a gap with no entry in gaps', () => {
    expect(
      validateClozeConfigShape(
        { text: 'A {{x}} and a {{y}}.', gaps: [{ id: 'x', accept: ['1'] }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects when gaps lists an id absent from text', () => {
    expect(
      validateClozeConfigShape(
        {
          text: 'A {{x}}.',
          gaps: [
            { id: 'x', accept: ['1'] },
            { id: 'unused', accept: ['2'] },
          ],
        },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects gaps with bad ids, empty accept, wrong-typed flags', () => {
    expect(
      validateClozeConfigShape(
        { text: 'A {{x}}.', gaps: [{ id: 'with space', accept: ['1'] }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape(
        { text: 'A {{x}}.', gaps: [{ id: 'x', accept: [] }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape(
        { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['1', ''] }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape(
        { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['1'], caseSensitive: 'yes' }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape(
        { text: 'A {{x}}.', gaps: [{ id: 'x', accept: ['1'], trimWhitespace: 'no' }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects duplicate gap ids in gaps[]', () => {
    expect(
      validateClozeConfigShape(
        {
          text: 'A {{x}} and {{x}}.',
          gaps: [
            { id: 'x', accept: ['1'] },
            { id: 'x', accept: ['2'] },
          ],
        },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('cloze_with_bank requires a non-empty bank of unique strings', () => {
    expect(isClozeWithBankConfig(ok())).toBe(false);
    expect(isClozeWithBankConfig(ok({ bank: ['one'] }))).toBe(true);
    expect(
      validateClozeConfigShape(ok({ bank: ['a', ''] }), { requireBank: true }).length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape(ok({ bank: ['dup', 'dup'] }), { requireBank: true }).length,
    ).toBeGreaterThan(0);
  });

  it('free cloze accepts an absent bank or rejects a malformed bank', () => {
    expect(validateClozeConfigShape(ok(), { requireBank: false })).toEqual([]);
    expect(
      validateClozeConfigShape(ok({ bank: ['a', ''] as unknown as readonly string[] }), {
        requireBank: false,
      }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects gap entries that are arrays or null (not plain objects)', () => {
    expect(
      validateClozeConfigShape({ text: 'A {{x}}.', gaps: [['nope']] }, { requireBank: false })
        .length,
    ).toBeGreaterThan(0);
    expect(
      validateClozeConfigShape({ text: 'A {{x}}.', gaps: [null] }, { requireBank: false }).length,
    ).toBeGreaterThan(0);
  });

  it('free cloze rejects bank that is not an array at all', () => {
    expect(
      validateClozeConfigShape(
        {
          text: 'A {{x}}.',
          gaps: [{ id: 'x', accept: ['1'] }],
          bank: 'not an array',
        },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('reports a parse error if text is unclosed', () => {
    expect(
      validateClozeConfigShape(
        { text: 'A {{open', gaps: [{ id: 'x', accept: ['1'] }] },
        { requireBank: false },
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('parseClozeRawAnswer', () => {
  it('parses one gap per line, first value wins', () => {
    const map = parseClozeRawAnswer('a=alpha\nb=beta\na=second');
    expect(map.get('a')).toBe('alpha');
    expect(map.get('b')).toBe('beta');
    expect(map.size).toBe(2);
  });

  it('drops malformed lines, blank values, bad ids', () => {
    const map = parseClozeRawAnswer('garbage\n=missing\nbad id=x\n\nokId=ok\nokId2=');
    expect(map.get('okId')).toBe('ok');
    expect(map.size).toBe(1);
  });

  it('preserves leading/trailing whitespace inside the value', () => {
    const map = parseClozeRawAnswer('a=  spaced  ');
    expect(map.get('a')).toBe('  spaced  ');
  });

  it('keeps a literal "=" inside the value', () => {
    const map = parseClozeRawAnswer('eq=2 + 2 = 4');
    expect(map.get('eq')).toBe('2 + 2 = 4');
  });
});

describe('markCloze', () => {
  const config: ClozeConfig = {
    text: '{{a}} and {{b}} and {{c}}.',
    gaps: [
      { id: 'a', accept: ['Apple', 'apples'] },
      { id: 'b', accept: ['banana'], caseSensitive: true },
      { id: 'c', accept: ['cherry'], trimWhitespace: false },
    ],
  };

  it('all-correct → every gap hit', () => {
    const out = markCloze(
      config,
      new Map([
        ['a', 'apple'],
        ['b', 'banana'],
        ['c', 'cherry'],
      ]),
    );
    expect(out.every((o) => o.hit)).toBe(true);
  });

  it('one wrong gap → partial hits', () => {
    const out = markCloze(
      config,
      new Map([
        ['a', 'pear'],
        ['b', 'banana'],
        ['c', 'cherry'],
      ]),
    );
    expect(out[0]!.hit).toBe(false);
    expect(out[1]!.hit).toBe(true);
    expect(out[2]!.hit).toBe(true);
  });

  it('blank pupil answer never hits', () => {
    const out = markCloze(config, new Map([['a', '']]));
    expect(out[0]!.hit).toBe(false);
    expect(out[0]!.pupilAnswer).toBe('');
  });

  it('caseSensitive=true rejects different-case match', () => {
    const out = markCloze(config, new Map([['b', 'BANANA']]));
    expect(out[1]!.hit).toBe(false);
  });

  it('default trimWhitespace=true accepts pad+collapse equivalents', () => {
    const out = markCloze(config, new Map([['a', '  Apple  ']]));
    expect(out[0]!.hit).toBe(true);
  });

  it('trimWhitespace=false demands an exact whitespace match', () => {
    const tight = markCloze(config, new Map([['c', '  cherry  ']]));
    expect(tight[2]!.hit).toBe(false);
    const exact = markCloze(config, new Map([['c', 'cherry']]));
    expect(exact[2]!.hit).toBe(true);
  });

  it('extra/unknown gap ids in pupilAnswers are ignored', () => {
    const out = markCloze(
      config,
      new Map([
        ['a', 'apple'],
        ['mystery', 'xyz'],
      ]),
    );
    expect(out[0]!.hit).toBe(true);
    expect(out).toHaveLength(3);
  });
});

describe('summariseCloze', () => {
  it('reports total/filled/hits and the per-gap outcomes', () => {
    const config: ClozeConfig = {
      text: '{{a}} {{b}} {{c}}',
      gaps: [
        { id: 'a', accept: ['1'] },
        { id: 'b', accept: ['2'] },
        { id: 'c', accept: ['3'] },
      ],
    };
    const sum = summariseCloze(
      config,
      new Map([
        ['a', '1'],
        ['b', 'wrong'],
      ]),
    );
    expect(sum.total).toBe(3);
    expect(sum.filled).toBe(2);
    expect(sum.hits).toBe(1);
    expect(sum.outcomes).toHaveLength(3);
  });
});
