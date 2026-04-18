import { describe, it, expect } from 'vitest';
import {
  markAttemptPart,
  parseMatrixTickMultiRawAnswer,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from '../../../src/services/marking/deterministic.js';

function mp(text: string, marks = 1): MarkingInputMarkPoint {
  return { text, accepted_alternatives: [], marks, is_required: false };
}

const ROWS = ['HTTPS', 'SMTP', 'IMAP', 'FTP'];
const COLUMNS = [
  'Transfers web pages',
  'Encrypts the traffic',
  'Sends email',
  'Retrieves email',
  'Transfers files',
];
const CORRECT: readonly (readonly string[])[] = [
  ['Transfers web pages', 'Encrypts the traffic'],
  ['Sends email'],
  ['Retrieves email'],
  ['Transfers files'],
];

const FLAT_MARKS = CORRECT.flatMap((row, i) => row.map((col) => mp(`${ROWS[i]!}: ${col}`)));

function configuredPart(opts: { partialCredit?: boolean } = {}): MarkingInputPart {
  return {
    marks: 5,
    expected_response_type: 'matrix_tick_multi',
    part_config: {
      rows: ROWS,
      columns: COLUMNS,
      correctByRow: CORRECT,
      ...(opts.partialCredit === undefined ? {} : { partialCredit: opts.partialCredit }),
    },
  };
}

describe('parseMatrixTickMultiRawAnswer', () => {
  it('groups multiple lines per row index into a Set', () => {
    const map = parseMatrixTickMultiRawAnswer('0=A\n0=B\n1=C');
    expect(map.get(0)).toEqual(new Set(['A', 'B']));
    expect(map.get(1)).toEqual(new Set(['C']));
    expect(map.has(2)).toBe(false);
  });

  it('drops malformed lines and blanks', () => {
    const map = parseMatrixTickMultiRawAnswer('garbage\n\n0=A\n0=\n=missing\nnine=junk');
    expect(map.get(0)).toEqual(new Set(['A']));
    expect(map.size).toBe(1);
  });

  it('deduplicates a column ticked twice on the same row', () => {
    const map = parseMatrixTickMultiRawAnswer('0=A\n0=A\n0=B');
    expect(map.get(0)).toEqual(new Set(['A', 'B']));
  });
});

describe('markAttemptPart — matrix_tick_multi', () => {
  it('awards full marks when every required cell is ticked exactly', () => {
    const r = markAttemptPart(
      configuredPart(),
      [
        '0=Transfers web pages',
        '0=Encrypts the traffic',
        '1=Sends email',
        '2=Retrieves email',
        '3=Transfers files',
      ].join('\n'),
      FLAT_MARKS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(5);
    expect(r.mark_point_outcomes.every((o) => o.hit)).toBe(true);
  });

  it('partial-credit (default): under-ticking awards the cells that were ticked', () => {
    const r = markAttemptPart(
      configuredPart(),
      ['0=Transfers web pages', '1=Sends email', '2=Retrieves email', '3=Transfers files'].join(
        '\n',
      ),
      FLAT_MARKS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(4);
    expect(r.mark_point_outcomes[0]!.hit).toBe(true);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
  });

  it('over-ticking a row zeroes that row, even with other rows correct', () => {
    const r = markAttemptPart(
      configuredPart(),
      [
        '0=Transfers web pages',
        '0=Encrypts the traffic',
        '0=Sends email',
        '1=Sends email',
        '2=Retrieves email',
        '3=Transfers files',
      ].join('\n'),
      FLAT_MARKS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(3);
    expect(r.mark_point_outcomes[0]!.hit).toBe(false);
    expect(r.mark_point_outcomes[1]!.hit).toBe(false);
  });

  it('partialCredit=false demands full set-equality per row', () => {
    const partial = markAttemptPart(
      configuredPart({ partialCredit: false }),
      ['0=Transfers web pages', '1=Sends email', '2=Retrieves email', '3=Transfers files'].join(
        '\n',
      ),
      FLAT_MARKS,
    );
    expect(partial.kind).toBe('awarded');
    if (partial.kind !== 'awarded') return;
    // Row 0 lacks "Encrypts the traffic" → no credit for row 0; rows 1–3 hit.
    expect(partial.marks_awarded).toBe(3);
    expect(partial.mark_point_outcomes[0]!.hit).toBe(false);
    expect(partial.mark_point_outcomes[1]!.hit).toBe(false);

    const full = markAttemptPart(
      configuredPart({ partialCredit: false }),
      [
        '0=Transfers web pages',
        '0=Encrypts the traffic',
        '1=Sends email',
        '2=Retrieves email',
        '3=Transfers files',
      ].join('\n'),
      FLAT_MARKS,
    );
    expect(full.kind).toBe('awarded');
    if (full.kind !== 'awarded') return;
    expect(full.marks_awarded).toBe(5);
  });

  it('drops ticks that name a column outside the configured set', () => {
    const r = markAttemptPart(
      configuredPart(),
      [
        '0=Transfers web pages',
        '0=Encrypts the traffic',
        '0=NOT-A-COLUMN',
        '1=Sends email',
        '2=Retrieves email',
        '3=Transfers files',
      ].join('\n'),
      FLAT_MARKS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(5);
  });

  it('matches case-insensitively via the shared normaliser', () => {
    const r = markAttemptPart(
      configuredPart(),
      [
        '0=transfers WEB pages',
        '0=ENCRYPTS the traffic',
        '1=sends EMAIL',
        '2=retrieves email',
        '3=Transfers Files',
      ].join('\n'),
      FLAT_MARKS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(5);
  });

  it('routes to teacher_pending when part_config is missing or malformed', () => {
    const noConfig: MarkingInputPart = {
      marks: 5,
      expected_response_type: 'matrix_tick_multi',
    };
    expect(markAttemptPart(noConfig, '0=Transfers web pages', FLAT_MARKS).kind).toBe(
      'teacher_pending',
    );

    const wrongShape: MarkingInputPart = {
      marks: 5,
      expected_response_type: 'matrix_tick_multi',
      part_config: { rows: ['R1'], columns: ['A', 'B'], correctByRow: ['A'] },
    };
    expect(markAttemptPart(wrongShape, '0=A', FLAT_MARKS).kind).toBe('teacher_pending');
  });

  it('treats blank rows as misses, not crashes', () => {
    const r = markAttemptPart(configuredPart(), '0=Transfers web pages', FLAT_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1);
    expect(r.mark_point_outcomes[2]!.hit).toBe(false);
  });

  it('clamps awarded to the part max', () => {
    const small: MarkingInputPart = {
      marks: 2,
      expected_response_type: 'matrix_tick_multi',
      part_config: {
        rows: ROWS,
        columns: COLUMNS,
        correctByRow: CORRECT,
      },
    };
    const r = markAttemptPart(
      small,
      [
        '0=Transfers web pages',
        '0=Encrypts the traffic',
        '1=Sends email',
        '2=Retrieves email',
        '3=Transfers files',
      ].join('\n'),
      FLAT_MARKS,
    );
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });
});
