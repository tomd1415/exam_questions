import { describe, it, expect } from 'vitest';
import {
  markAttemptPart,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from '../../../src/services/marking/deterministic.js';

function part(type: string, marks: number): MarkingInputPart {
  return { marks, expected_response_type: type };
}

function mp(
  overrides: Partial<MarkingInputMarkPoint> & Pick<MarkingInputMarkPoint, 'text'>,
): MarkingInputMarkPoint {
  return {
    text: overrides.text,
    accepted_alternatives: overrides.accepted_alternatives ?? [],
    marks: overrides.marks ?? 1,
    is_required: overrides.is_required ?? false,
  };
}

describe('markAttemptPart — multiple_choice', () => {
  const mc = part('multiple_choice', 1);
  const options = [mp({ text: 'RAM', marks: 1 }), mp({ text: 'ROM', marks: 0 })];

  it('awards full marks for an exact correct answer', () => {
    const r = markAttemptPart(mc, 'RAM', options);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1);
    expect(r.marks_possible).toBe(1);
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
  });

  it('awards 0 for an incorrect option', () => {
    const r = markAttemptPart(mc, 'ROM', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
  });

  it('awards 0 for a blank answer', () => {
    const r = markAttemptPart(mc, '   ', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
    expect(r.mark_point_outcomes.every((o) => o.hit === false)).toBe(true);
  });

  it('accepts a normalised match (smart quotes / trailing dot)', () => {
    const opt = [mp({ text: "don't", marks: 1 })];
    const r = markAttemptPart(mc, '  Don\u2019T.  ', opt);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(1);
  });

  it('accepts an accepted_alternative even when primary text differs', () => {
    const opt = [mp({ text: 'random access memory', accepted_alternatives: ['RAM'], marks: 1 })];
    const r = markAttemptPart(mc, 'ram', opt);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(1);
  });
});

describe('markAttemptPart — tick_box', () => {
  const tb = part('tick_box', 2);
  // Only correct options are mark points; distractors (e.g. "Monitor") are
  // not listed, so ticking them counts as an incorrect tick.
  const options = [mp({ text: 'CPU', marks: 1 }), mp({ text: 'RAM', marks: 1 })];

  it('awards full marks when both correct boxes are ticked', () => {
    const r = markAttemptPart(tb, 'CPU\nRAM', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(2);
  });

  it('awards partial credit for one correct tick', () => {
    const r = markAttemptPart(tb, 'CPU', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(1);
  });

  it('penalises over-ticking (one right + one wrong = 0)', () => {
    const r = markAttemptPart(tb, 'CPU, Monitor', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
  });

  it('never goes below zero when only wrong answers are ticked', () => {
    const r = markAttemptPart(tb, 'Monitor, Keyboard', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
  });

  it('treats blank as 0 marks, not as negative', () => {
    const r = markAttemptPart(tb, '', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
  });

  it('deduplicates repeated ticks of the same option (counts one hit)', () => {
    const r = markAttemptPart(tb, 'CPU\nCPU\nRAM', options);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    // One incorrect duplicate tick: correct=2, incorrect=1 → award=1, but capped to hit weight of 2
    expect(r.marks_awarded).toBe(1);
  });
});

describe('markAttemptPart — short_text', () => {
  const st = part('short_text', 2);
  const markPoints = [
    mp({ text: 'arithmetic operations', marks: 1 }),
    mp({ text: 'logic operations', accepted_alternatives: ['logical operations'], marks: 1 }),
  ];

  it('awards for a substring match', () => {
    const r = markAttemptPart(
      st,
      'The ALU performs arithmetic operations and logic operations.',
      markPoints,
    );
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(2);
  });

  it('accepts an alternative spelling', () => {
    const r = markAttemptPart(
      st,
      'It does arithmetic operations and logical operations.',
      markPoints,
    );
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(2);
  });

  it('awards partial marks when one mark point is missed', () => {
    const r = markAttemptPart(st, 'Does arithmetic operations only.', markPoints);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(1);
    expect(r.mark_point_outcomes.filter((o) => o.hit)).toHaveLength(1);
  });

  it('awards 0 for a close-miss (wrong keywords)', () => {
    const r = markAttemptPart(st, 'The ALU is very important.', markPoints);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
  });

  it('awards 0 for a blank answer', () => {
    const r = markAttemptPart(st, '   ', markPoints);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
  });

  it('ignores an empty mark-point text and only matches alternatives', () => {
    const pts = [mp({ text: '', accepted_alternatives: ['fetch'], marks: 1 })];
    const r = markAttemptPart(part('short_text', 1), 'The CPU will fetch an instruction.', pts);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(1);
  });

  it('clamps marks_awarded to marks_possible', () => {
    const pts = [mp({ text: 'alu', marks: 5 })]; // deliberately over-weighted
    const r = markAttemptPart(part('short_text', 2), 'alu', pts);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(2);
    expect(r.marks_awarded).toBeLessThanOrEqual(r.marks_possible);
  });

  it('clamps to 0 when a required mark point is missed', () => {
    const pts = [
      mp({ text: 'alu', marks: 1 }),
      mp({ text: 'registers', marks: 1, is_required: true }),
    ];
    const r = markAttemptPart(part('short_text', 2), 'The alu is important.', pts);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(0);
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
  });

  it('awards full marks when the required mark point is hit', () => {
    const pts = [mp({ text: 'registers', marks: 1, is_required: true })];
    const r = markAttemptPart(part('short_text', 1), 'The CPU uses registers.', pts);
    if (r.kind !== 'awarded') throw new Error('expected awarded');
    expect(r.marks_awarded).toBe(1);
  });
});

describe('markAttemptPart — open response types', () => {
  it.each(['medium_text', 'extended_response', 'code', 'algorithm', 'logic_diagram', 'flowchart'])(
    'returns teacher_pending for %s',
    (type) => {
      const r = markAttemptPart(part(type, 6), 'anything at all', []);
      expect(r.kind).toBe('teacher_pending');
      if (r.kind !== 'teacher_pending') return;
      expect(r.marks_possible).toBe(6);
      expect(r.reason).toBe('open_response');
    },
  );
});

describe('markAttemptPart — unknown type', () => {
  it('returns teacher_pending with reason unknown_type (safe fallback)', () => {
    const r = markAttemptPart(part('zombie_type', 3), 'x', []);
    expect(r.kind).toBe('teacher_pending');
    if (r.kind !== 'teacher_pending') return;
    expect(r.reason).toBe('unknown_type');
    expect(r.marks_possible).toBe(3);
  });
});

describe('markAttemptPart — invariants', () => {
  it('marks_awarded is always ≤ marks_possible across many shapes', () => {
    const shapes: [MarkingInputPart, string, MarkingInputMarkPoint[]][] = [
      [part('short_text', 1), 'foo bar baz', [mp({ text: 'foo', marks: 10 })]],
      [part('tick_box', 2), 'a\nb\nc', [mp({ text: 'a', marks: 5 }), mp({ text: 'b', marks: 5 })]],
      [part('multiple_choice', 1), 'x', [mp({ text: 'x', marks: 99 })]],
    ];
    for (const [p, answer, pts] of shapes) {
      const r = markAttemptPart(p, answer, pts);
      if (r.kind !== 'awarded') continue;
      expect(r.marks_awarded).toBeGreaterThanOrEqual(0);
      expect(r.marks_awarded).toBeLessThanOrEqual(r.marks_possible);
    }
  });
});
