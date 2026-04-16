import { describe, it, expect } from 'vitest';
import { normalise } from '../../../src/services/marking/normalise.js';

describe('normalise', () => {
  it('lower-cases ASCII letters', () => {
    expect(normalise('ALU')).toBe('alu');
    expect(normalise('Hello World')).toBe('hello world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalise('   hello   ')).toBe('hello');
    expect(normalise('\t\nhello\t\n')).toBe('hello');
  });

  it('collapses internal whitespace to a single space', () => {
    expect(normalise('a    b\t\tc\n\nd')).toBe('a b c d');
  });

  it('canonicalises curly single quotes to straight', () => {
    expect(normalise('it\u2019s')).toBe("it's");
    expect(normalise('\u2018hello\u2019')).toBe("'hello'");
  });

  it('canonicalises curly double quotes to straight', () => {
    expect(normalise('\u201Chi\u201D')).toBe('"hi"');
  });

  it('canonicalises en-dash, em-dash and minus to hyphen-minus', () => {
    expect(normalise('a\u2013b')).toBe('a-b');
    expect(normalise('a\u2014b')).toBe('a-b');
    expect(normalise('a\u2212b')).toBe('a-b');
  });

  it('strips a single trailing full stop', () => {
    expect(normalise('addition.')).toBe('addition');
  });

  it('strips trailing punctuation clusters', () => {
    expect(normalise('really?!')).toBe('really');
    expect(normalise('hmm...')).toBe('hmm');
    expect(normalise('a, b, c.')).toBe('a, b, c');
  });

  it('does not strip punctuation inside the answer', () => {
    expect(normalise('a.b.c')).toBe('a.b.c');
  });

  it('handles the empty string', () => {
    expect(normalise('')).toBe('');
    expect(normalise('   ')).toBe('');
    expect(normalise('...')).toBe('');
  });

  it('is idempotent', () => {
    const cases = [
      'Hello, World!',
      '  The ALU\u2019s job  ',
      '\u201Cquote\u201D',
      'a\u2014b\u2013c',
      'trailing??',
      'already normalised',
    ];
    for (const c of cases) {
      expect(normalise(normalise(c))).toBe(normalise(c));
    }
  });
});
