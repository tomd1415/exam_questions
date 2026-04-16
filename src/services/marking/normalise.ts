// Deterministic text normalisation for marking. Every rule here makes
// two answers that "should" count as the same look identical. The
// function is pure, idempotent (normalise(normalise(x)) === normalise(x))
// and unicode-naive — no locale-specific folding beyond ASCII lowercase.

const SMART_SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2035]/g;
const SMART_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u2036]/g;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const WHITESPACE_RUN = /\s+/g;
const TRAILING_PUNCTUATION = /[.,;:!?\s]+$/;

export function normalise(input: string): string {
  return input
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .toLowerCase()
    .replace(TRAILING_PUNCTUATION, '');
}
