import type { AwardedMarkRow } from '../repos/attempts.js';
import { isReadable } from './reading-level.js';

// Decides what AI-feedback block, if any, is shown to the pupil on
// the attempt review page. The gate lives here rather than in the
// Eta template so the substitution rules stay testable in
// isolation: the template only cares about the shape of the result.
//
// Chunk 3e rules:
//   - Deterministic rows: nothing extra (objective marking has its
//     own hit/miss grid).
//   - LLM rows still in moderation: suppress until the teacher
//     clears them. We never leak a flagged AI feedback block to the
//     pupil before review.
//   - Teacher-override rows: hide the AI feedback (it may no longer
//     be true relative to the new mark) and show the teacher's
//     override reason instead.
//   - Otherwise (LLM + accepted/not_required + feedback present):
//     show the three blocks, each swapped for a fallback if the
//     LLM's prose scores below the Flesch threshold.

export interface PupilFeedbackAi {
  kind: 'ai';
  what_went_well: string;
  how_to_gain_more: string;
  next_focus: string;
  anySubstituted: boolean;
}

export interface PupilFeedbackOverride {
  kind: 'overridden';
  overrideReason: string;
}

export interface PupilFeedbackNone {
  kind: 'none';
}

export type PupilFeedback = PupilFeedbackAi | PupilFeedbackOverride | PupilFeedbackNone;

export const GENERIC_PUPIL_FALLBACK = 'Ask your teacher to talk this through with you.';

export function buildPupilFeedback(
  awarded: AwardedMarkRow | undefined,
  partFallback: string | null,
): PupilFeedback {
  if (!awarded) return { kind: 'none' };
  if (awarded.marker === 'deterministic') return { kind: 'none' };
  if (awarded.marker === 'teacher_override') {
    return {
      kind: 'overridden',
      overrideReason: (awarded.override_reason ?? '').trim(),
    };
  }
  // marker === 'llm'
  if (awarded.moderation_status === 'pending') return { kind: 'none' };
  if (!awarded.feedback_for_pupil) return { kind: 'none' };

  const fallback =
    partFallback && partFallback.trim().length > 0 ? partFallback : GENERIC_PUPIL_FALLBACK;
  const f = awarded.feedback_for_pupil;
  const wentWell = isReadable(f.what_went_well) ? f.what_went_well : fallback;
  const howMore = isReadable(f.how_to_gain_more) ? f.how_to_gain_more : fallback;
  const nextFocus = isReadable(f.next_focus) ? f.next_focus : fallback;
  const anySubstituted =
    wentWell !== f.what_went_well || howMore !== f.how_to_gain_more || nextFocus !== f.next_focus;
  return {
    kind: 'ai',
    what_went_well: wentWell,
    how_to_gain_more: howMore,
    next_focus: nextFocus,
    anySubstituted,
  };
}
