import { describe, expect, it } from 'vitest';
import type { AwardedMarkRow } from '../../src/repos/attempts.js';
import { GENERIC_PUPIL_FALLBACK, buildPupilFeedback } from '../../src/lib/pupil-feedback.js';

function llmRow(overrides: Partial<AwardedMarkRow> = {}): AwardedMarkRow {
  return {
    id: '1',
    attempt_part_id: '10',
    marks_awarded: 2,
    marks_total: 4,
    mark_points_hit: [],
    mark_points_missed: [],
    marker: 'llm',
    moderation_status: 'not_required',
    feedback_for_pupil: {
      what_went_well: 'You named the two parts.',
      how_to_gain_more: 'Say what each part does.',
      next_focus: 'Compare how the CPU and GPU work.',
    },
    override_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('buildPupilFeedback', () => {
  it('returns none when no awarded row yet', () => {
    expect(buildPupilFeedback(undefined, null)).toEqual({ kind: 'none' });
  });

  it('returns none for deterministic marker (objective marking owns the display)', () => {
    expect(buildPupilFeedback(llmRow({ marker: 'deterministic' }), null)).toEqual({
      kind: 'none',
    });
  });

  it('suppresses feedback while still pending moderation', () => {
    expect(buildPupilFeedback(llmRow({ moderation_status: 'pending' }), null)).toEqual({
      kind: 'none',
    });
  });

  it('shows AI feedback when LLM + accepted', () => {
    const result = buildPupilFeedback(llmRow({ moderation_status: 'accepted' }), null);
    expect(result.kind).toBe('ai');
    if (result.kind !== 'ai') return;
    expect(result.what_went_well).toContain('named the two parts');
    expect(result.anySubstituted).toBe(false);
  });

  it('shows AI feedback when LLM + not_required', () => {
    const result = buildPupilFeedback(llmRow(), null);
    expect(result.kind).toBe('ai');
  });

  it('substitutes the generic fallback when a block is unreadable', () => {
    const awarded = llmRow({
      feedback_for_pupil: {
        what_went_well:
          'Your articulation of juxtaposed microprocessor functionalities was ' +
          'contextualised operationally, demonstrating sophistication beyond mere nomenclature.',
        how_to_gain_more: 'Say what each one does.',
        next_focus: 'Practise comparing the CPU and GPU.',
      },
    });
    const result = buildPupilFeedback(awarded, null);
    expect(result.kind).toBe('ai');
    if (result.kind !== 'ai') return;
    expect(result.what_went_well).toBe(GENERIC_PUPIL_FALLBACK);
    expect(result.how_to_gain_more).toContain('Say what each one does.');
    expect(result.anySubstituted).toBe(true);
  });

  it('prefers the per-part teacher-authored fallback over the generic one', () => {
    const awarded = llmRow({
      feedback_for_pupil: {
        what_went_well:
          'Your articulation of juxtaposed microprocessor functionalities was ' +
          'contextualised operationally, demonstrating sophistication beyond nomenclature.',
        how_to_gain_more: 'Say what each one does.',
        next_focus: 'Practise comparing the CPU and GPU.',
      },
    });
    const result = buildPupilFeedback(awarded, 'Look again at the CPU page in the booklet.');
    expect(result.kind).toBe('ai');
    if (result.kind !== 'ai') return;
    expect(result.what_went_well).toBe('Look again at the CPU page in the booklet.');
  });

  it('surfaces the override reason and suppresses AI feedback', () => {
    const awarded = llmRow({
      marker: 'teacher_override',
      moderation_status: 'not_required',
      feedback_for_pupil: null,
      override_reason: 'AI over-marked — no evidence of the second half.',
    });
    const result = buildPupilFeedback(awarded, null);
    expect(result).toEqual({
      kind: 'overridden',
      overrideReason: 'AI over-marked — no evidence of the second half.',
    });
  });

  it('returns none when LLM row has no feedback column populated (legacy row)', () => {
    const awarded = llmRow({ feedback_for_pupil: null });
    expect(buildPupilFeedback(awarded, null)).toEqual({ kind: 'none' });
  });
});
