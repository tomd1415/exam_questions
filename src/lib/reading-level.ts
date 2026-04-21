// Flesch Reading Ease scorer. Used by the pupil-feedback renderer
// (chunk 3e) to suppress LLM feedback blocks that are too hard for
// a Year-10/11 GCSE pupil to read and substitute a teacher-authored
// or generic fallback.
//
// Score formula (Flesch, 1948):
//   206.835 − 1.015 × (words / sentences) − 84.6 × (syllables / words)
//
// Guidance (commonly-used bands):
//   90+  very easy            60+  plain English (Year 8–10)
//   70+  fairly easy          50+  fairly hard
//   30+  difficult            <30  very difficult
//
// We treat <60 as "replace with fallback". Anything empty, or short
// enough that the formula breaks (no sentences), is treated as
// score=100 (ie. acceptable) rather than flagged, because a one-line
// "Well done!" is fine — the fallback is for impenetrable paragraphs,
// not short text.

const SENTENCE_TERMINATORS = /[.!?]+/g;
const WORD_SPLIT = /[^\p{L}\p{N}']+/u;
const VOWEL_GROUP = /[aeiouy]+/g;

export const ACCEPTABLE_FLESCH_THRESHOLD = 60;

export function fleschReadingEase(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 100;

  const sentences = countSentences(trimmed);
  const words = splitWords(trimmed);
  if (sentences === 0 || words.length === 0) return 100;

  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = words.length / sentences;
  const syllablesPerWord = syllables / words.length;
  return 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
}

export function isReadable(text: string): boolean {
  return fleschReadingEase(text) >= ACCEPTABLE_FLESCH_THRESHOLD;
}

function countSentences(text: string): number {
  const matches = text.match(SENTENCE_TERMINATORS);
  if (matches && matches.length > 0) return matches.length;
  return 1;
}

function splitWords(text: string): string[] {
  return text
    .split(WORD_SPLIT)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

function countSyllables(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length === 0) return 0;
  if (word.length <= 3) return 1;
  const stripped = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/u, '');
  const groups = stripped.match(VOWEL_GROUP);
  return Math.max(1, groups ? groups.length : 1);
}
