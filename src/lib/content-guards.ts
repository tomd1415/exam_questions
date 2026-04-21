// Seed patterns for the safety gate's two guard lists. Admins can
// extend both lists at runtime via content_guard_patterns (migration
// 0031); these arrays are the built-in floor that ships with every
// deployment and cannot be turned off from the UI. The runtime
// matcher unions the seeds with the DB rows before every mark.
//
// Matching is case-insensitive substring. Patterns are plain strings,
// not regex — see migration 0031 for why.

export const SEED_SAFEGUARDING_PATTERNS: readonly string[] = [
  'kill myself',
  'end my life',
  'want to die',
  'suicide',
  'self harm',
  'self-harm',
  'cut myself',
  'hurt myself',
  'no one would miss me',
  'hurting me',
  'beats me',
  'hits me',
  'abuse me',
  'abuses me',
];

export const SEED_PROMPT_INJECTION_PATTERNS: readonly string[] = [
  'ignore previous instructions',
  'ignore the above',
  'ignore all previous',
  'disregard the above',
  'disregard previous instructions',
  'you are now',
  'act as',
  'pretend you are',
  'system prompt',
  'full marks',
  'give me full marks',
  'award full marks',
  'award all marks',
  'mark this as correct',
  'you must give',
  'override your instructions',
  'new instructions:',
  'developer mode',
];

export function matchesAny(text: string, patterns: readonly string[]): string | null {
  const haystack = text.toLowerCase();
  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    if (haystack.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}
