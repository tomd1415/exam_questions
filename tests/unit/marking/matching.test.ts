import { describe, it, expect } from 'vitest';
import {
  markAttemptPart,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from '../../../src/services/marking/deterministic.js';

function mp(text: string, marks = 1): MarkingInputMarkPoint {
  return { text, accepted_alternatives: [], marks, is_required: false };
}

function configuredPart(opts: { partialCredit?: boolean; marks?: number } = {}): MarkingInputPart {
  return {
    marks: opts.marks ?? 3,
    expected_response_type: 'matching',
    part_config: {
      left: ['HTTP', 'SMTP', 'FTP'],
      right: ['web pages', 'email', 'file transfer', 'remote shell'],
      correctPairs: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      ...(opts.partialCredit === undefined ? {} : { partialCredit: opts.partialCredit }),
    },
  };
}

const MARK_POINTS = [mp('HTTP — web pages'), mp('SMTP — email'), mp('FTP — file transfer')];

describe('markAttemptPart — matching', () => {
  it('awards full marks for an entirely correct pairing', () => {
    const r = markAttemptPart(configuredPart(), ['0=0', '1=1', '2=2'].join('\n'), MARK_POINTS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(3);
    expect(r.mark_point_outcomes.every((o) => o.hit)).toBe(true);
    expect(r.normalised_answer).toBe('0=0\n1=1\n2=2');
  });

  it('partial credit (default): one wrong pair still scores the other two', () => {
    const r = markAttemptPart(configuredPart(), ['0=0', '1=1', '2=3'].join('\n'), MARK_POINTS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
    expect(r.mark_point_outcomes[1]!.hit).toBe(true);
    expect(r.mark_point_outcomes[2]!.hit).toBe(false);
  });

  it('partialCredit=false: any miss zeros the whole part', () => {
    const part = configuredPart({ partialCredit: false });
    const partial = markAttemptPart(part, ['0=0', '1=1'].join('\n'), MARK_POINTS);
    expect(partial.kind).toBe('awarded');
    if (partial.kind !== 'awarded') return;
    expect(partial.marks_awarded).toBe(0);
    expect(partial.mark_point_outcomes.every((o) => !o.hit)).toBe(true);

    const full = markAttemptPart(part, ['0=0', '1=1', '2=2'].join('\n'), MARK_POINTS);
    expect(full.kind).toBe('awarded');
    if (full.kind !== 'awarded') return;
    expect(full.marks_awarded).toBe(3);
    expect(full.mark_point_outcomes.every((o) => o.hit)).toBe(true);
  });

  it('clamps to part.marks when correctPairs exceeds marks', () => {
    const r = markAttemptPart(
      configuredPart({ marks: 2 }),
      ['0=0', '1=1', '2=2'].join('\n'),
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('a distractor pick is never accepted', () => {
    const r = markAttemptPart(
      configuredPart(),
      ['0=0', '1=3', '2=2'].join('\n'), // right[3]="remote shell" is a distractor
      MARK_POINTS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
  });

  it('routes to teacher_pending when part_config is missing or malformed', () => {
    const noConfig: MarkingInputPart = {
      marks: 3,
      expected_response_type: 'matching',
    };
    expect(markAttemptPart(noConfig, '0=0', MARK_POINTS).kind).toBe('teacher_pending');

    const wrongShape: MarkingInputPart = {
      marks: 3,
      expected_response_type: 'matching',
      part_config: { left: [], right: [], correctPairs: [] },
    };
    expect(markAttemptPart(wrongShape, '0=0', MARK_POINTS).kind).toBe('teacher_pending');
  });
});
