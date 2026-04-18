import { describe, it, expect } from 'vitest';
import {
  markAttemptPart,
  parseMatrixTickRawAnswer,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from '../../../src/services/marking/deterministic.js';

function mp(text: string, marks = 1): MarkingInputMarkPoint {
  return { text, accepted_alternatives: [], marks, is_required: false };
}

const ROWS = ['RAM', 'ROM', 'HDD'];
const COLUMNS = ['Volatile primary', 'Non-volatile primary', 'Secondary'];
const CORRECT = ['Volatile primary', 'Non-volatile primary', 'Secondary'];

function configuredPart(opts: { allOrNothing?: boolean } = {}): MarkingInputPart {
  return {
    marks: 3,
    expected_response_type: 'matrix_tick_single',
    part_config: {
      rows: ROWS,
      columns: COLUMNS,
      correctByRow: CORRECT,
      ...(opts.allOrNothing === undefined ? {} : { allOrNothing: opts.allOrNothing }),
    },
  };
}

const MARK_POINTS = ROWS.map((r, i) => mp(`${r} → ${CORRECT[i]!}`));

describe('parseMatrixTickRawAnswer', () => {
  it('parses a well-formed multi-line raw_answer', () => {
    const map = parseMatrixTickRawAnswer('0=Volatile primary\n1=Non-volatile primary');
    expect(map.get(0)).toBe('Volatile primary');
    expect(map.get(1)).toBe('Non-volatile primary');
    expect(map.has(2)).toBe(false);
  });

  it('ignores malformed lines and blanks', () => {
    const map = parseMatrixTickRawAnswer('garbage\n\n0=A\n=missing-key\n1=\nfive=junk');
    expect(map.get(0)).toBe('A');
    expect(map.has(1)).toBe(false);
    expect(map.size).toBe(1);
  });

  it('keeps the first selection per row when duplicates are sent', () => {
    const map = parseMatrixTickRawAnswer('0=First\n0=Second');
    expect(map.get(0)).toBe('First');
  });
});

describe('markAttemptPart — matrix_tick_single', () => {
  it('awards full marks when every row is correct', () => {
    const r = markAttemptPart(
      configuredPart(),
      '0=Volatile primary\n1=Non-volatile primary\n2=Secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(3);
    expect(r.mark_point_outcomes.every((o) => o.hit)).toBe(true);
  });

  it('awards N-1 marks when one row is wrong (default per-row scoring)', () => {
    const r = markAttemptPart(
      configuredPart(),
      '0=Volatile primary\n1=Secondary\n2=Secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
    expect(r.mark_point_outcomes[2]!.hit).toBe(true);
  });

  it('awards zero under allOrNothing if any row is wrong', () => {
    const r = markAttemptPart(
      configuredPart({ allOrNothing: true }),
      '0=Volatile primary\n1=Secondary\n2=Secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(0);
  });

  it('still awards full marks under allOrNothing when every row is right', () => {
    const r = markAttemptPart(
      configuredPart({ allOrNothing: true }),
      '0=Volatile primary\n1=Non-volatile primary\n2=Secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(3);
  });

  it('treats blank rows as misses, not crashes', () => {
    const r = markAttemptPart(configuredPart(), '0=Volatile primary', MARK_POINTS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
    expect(r.mark_point_outcomes[2]!.hit).toBe(false);
  });

  it('ignores selections that name a column outside the configured set', () => {
    const r = markAttemptPart(
      configuredPart(),
      '0=Volatile primary\n1=Bogus column\n2=Secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
    expect(r.marks_awarded).toBe(2);
  });

  it('ignores out-of-range row indices in raw_answer without crashing', () => {
    const r = markAttemptPart(
      configuredPart(),
      '0=Volatile primary\n9=Volatile primary\n2=Secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('routes to teacher_pending when part_config is missing or malformed', () => {
    const noConfig: MarkingInputPart = {
      marks: 3,
      expected_response_type: 'matrix_tick_single',
    };
    const r1 = markAttemptPart(noConfig, '0=Volatile primary', MARK_POINTS);
    expect(r1.kind).toBe('teacher_pending');

    const badConfig: MarkingInputPart = {
      marks: 3,
      expected_response_type: 'matrix_tick_single',
      part_config: { rows: ['RAM'], columns: ['A', 'B'], correctByRow: ['A', 'B'] },
    };
    const r2 = markAttemptPart(badConfig, '0=A', MARK_POINTS);
    expect(r2.kind).toBe('teacher_pending');
  });

  it('matches case-insensitively (via the shared normaliser)', () => {
    const r = markAttemptPart(
      configuredPart(),
      '0=VOLATILE primary\n1=non-volatile PRIMARY\n2=secondary',
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(3);
  });
});
