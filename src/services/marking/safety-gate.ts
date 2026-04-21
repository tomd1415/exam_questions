import { matchesAny } from '../../lib/content-guards.js';

// Deterministic post-LLM safety gate. See PROMPTS.md §Safety gate and
// PHASE3_PLAN.md §5 chunk 3d. Runs on the `awarded` outcome of every
// LLM mark and flags the row for teacher moderation when any rule
// fires. The full reason list is stored in awarded_marks.moderation_notes
// so the moderation page can render "here's why" without re-running
// the gate against the pupil's answer on every request.
//
// Pure function: no DB, no logging, no audit. The caller (dispatch.ts)
// decides what to do with the returned flag. Refusal and http_error
// paths divert before they reach here, so `refusal=true` is not a
// gate rule in code — the existing `kind: 'refusal'` outcome in
// llm.ts already routes those to `pending`.

export type SafetyGateReason =
  | { kind: 'low_confidence'; confidence: number; threshold: number }
  | { kind: 'marks_without_evidence'; marksAwarded: number }
  | { kind: 'evidence_not_in_answer'; quote: string }
  | { kind: 'marks_clipped'; rawAwarded: number; marksTotal: number }
  | { kind: 'safeguarding_pattern'; pattern: string }
  | { kind: 'prompt_injection_pattern'; pattern: string };

export const CONFIDENCE_THRESHOLD = 0.6;

export interface SafetyGateInput {
  readonly pupilAnswer: string;
  readonly confidence: number;
  readonly marksAwarded: number;
  readonly marksAwardedRaw: number;
  readonly marksTotal: number;
  readonly hitMarkPointCount: number;
  readonly evidenceQuotes: readonly string[];
  readonly safeguardingPatterns: readonly string[];
  readonly promptInjectionPatterns: readonly string[];
}

export interface SafetyGateResult {
  readonly flagged: boolean;
  readonly reasons: readonly SafetyGateReason[];
}

export function evaluateSafetyGate(input: SafetyGateInput): SafetyGateResult {
  const reasons: SafetyGateReason[] = [];

  if (input.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push({
      kind: 'low_confidence',
      confidence: input.confidence,
      threshold: CONFIDENCE_THRESHOLD,
    });
  }

  if (input.marksAwarded > 0 && input.hitMarkPointCount === 0) {
    reasons.push({ kind: 'marks_without_evidence', marksAwarded: input.marksAwarded });
  }

  const answerLower = input.pupilAnswer.toLowerCase();
  for (const quote of input.evidenceQuotes) {
    const q = quote.trim();
    if (q.length === 0) continue;
    if (!answerLower.includes(q.toLowerCase())) {
      reasons.push({ kind: 'evidence_not_in_answer', quote });
    }
  }

  if (input.marksAwardedRaw > input.marksTotal) {
    reasons.push({
      kind: 'marks_clipped',
      rawAwarded: input.marksAwardedRaw,
      marksTotal: input.marksTotal,
    });
  }

  const safeHit = matchesAny(input.pupilAnswer, input.safeguardingPatterns);
  if (safeHit !== null) {
    reasons.push({ kind: 'safeguarding_pattern', pattern: safeHit });
  }

  const piHit = matchesAny(input.pupilAnswer, input.promptInjectionPatterns);
  if (piHit !== null) {
    reasons.push({ kind: 'prompt_injection_pattern', pattern: piHit });
  }

  return { flagged: reasons.length > 0, reasons };
}
