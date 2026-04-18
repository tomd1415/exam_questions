import { describe, it, expect } from 'vitest';
import {
  markAttemptPart,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from '../../../src/services/marking/deterministic.js';

function mp(text: string, marks = 1): MarkingInputMarkPoint {
  return { text, accepted_alternatives: [], marks, is_required: false };
}

const COLUMNS = [{ name: 'i' }, { name: 'total' }, { name: 'output' }];

function configuredPart(
  opts: {
    mode?: 'perCell' | 'perRow' | 'allOrNothing';
    marks?: number;
  } = {},
): MarkingInputPart {
  return {
    marks: opts.marks ?? 4,
    expected_response_type: 'trace_table',
    part_config: {
      columns: COLUMNS,
      rows: 5,
      prefill: { '0,0': '1', '1,0': '2', '2,0': '3', '3,0': '4' },
      expected: {
        '0,1': '2',
        '1,1': '6',
        '2,1': '12',
        '3,1': '20',
        '4,2': '20',
      },
      marking: { mode: opts.mode ?? 'perCell' },
    },
  };
}

const MARK_POINTS = [
  mp('row 1: total = 2'),
  mp('row 2: total = 6'),
  mp('row 3: total = 12'),
  mp('row 4: total = 20'),
  mp('output: 20'),
];

describe('markAttemptPart — trace_table', () => {
  it('awards full marks for an entirely correct grid', () => {
    const r = markAttemptPart(
      configuredPart(),
      ['0,1=2', '1,1=6', '2,1=12', '3,1=20', '4,2=20'].join('\n'),
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(4);
    expect(r.mark_point_outcomes.every((o) => o.hit)).toBe(true);
  });

  it('clamps to part.marks when there are more expected cells than marks', () => {
    const r = markAttemptPart(
      configuredPart({ marks: 3 }),
      ['0,1=2', '1,1=6', '2,1=12', '3,1=20', '4,2=20'].join('\n'),
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(3);
  });

  it('per-cell partial credit on a partial answer', () => {
    const r = markAttemptPart(
      configuredPart(),
      ['0,1=2', '1,1=6', '2,1=WRONG'].join('\n'),
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
    expect(r.mark_point_outcomes[1]!.hit).toBe(true);
    expect(r.mark_point_outcomes[2]!.hit).toBe(false);
    expect(r.mark_point_outcomes[3]!.hit).toBe(false);
    expect(r.mark_point_outcomes[4]!.hit).toBe(false);
  });

  it('perRow: a wrong cell zeroes the whole row but preserves other rows', () => {
    const r = markAttemptPart(
      configuredPart({ mode: 'perRow' }),
      // row 0 perfect (1 expected cell), row 1 wrong, rest blank.
      ['0,1=2', '1,1=WRONG'].join('\n'),
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1); // only row 0 fully correct
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
  });

  it('allOrNothing: any miss → 0', () => {
    const partial = markAttemptPart(
      configuredPart({ mode: 'allOrNothing' }),
      ['0,1=2', '1,1=6', '2,1=12', '3,1=20'].join('\n'),
      MARK_POINTS,
    );
    expect(partial.kind).toBe('awarded');
    if (partial.kind !== 'awarded') return;
    expect(partial.marks_awarded).toBe(0);

    const full = markAttemptPart(
      configuredPart({ mode: 'allOrNothing' }),
      ['0,1=2', '1,1=6', '2,1=12', '3,1=20', '4,2=20'].join('\n'),
      MARK_POINTS,
    );
    expect(full.kind).toBe('awarded');
    if (full.kind !== 'awarded') return;
    expect(full.marks_awarded).toBe(4);
  });

  it('normalised_answer keeps only expected cells in row,col order', () => {
    const r = markAttemptPart(
      configuredPart(),
      ['1,1=6', '0,1=2', '9,9=junk', '4,2=20', '2,1=12', '3,1=20'].join('\n'),
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.normalised_answer).toBe('0,1=2\n1,1=6\n2,1=12\n3,1=20\n4,2=20');
  });

  it('routes to teacher_pending when part_config is missing or malformed', () => {
    const noConfig: MarkingInputPart = {
      marks: 4,
      expected_response_type: 'trace_table',
    };
    expect(markAttemptPart(noConfig, '0,1=2', MARK_POINTS).kind).toBe('teacher_pending');

    const wrongShape: MarkingInputPart = {
      marks: 4,
      expected_response_type: 'trace_table',
      part_config: { columns: [], rows: 0, expected: {}, marking: {} },
    };
    expect(markAttemptPart(wrongShape, '0,1=2', MARK_POINTS).kind).toBe('teacher_pending');
  });
});
