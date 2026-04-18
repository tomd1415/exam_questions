import { describe, it, expect } from 'vitest';
import {
  markAttemptPart,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from '../../../src/services/marking/deterministic.js';

function mp(text: string, marks = 1): MarkingInputMarkPoint {
  return { text, accepted_alternatives: [], marks, is_required: false };
}

const FREE_CONFIG = {
  text: 'Eight bits make a {{u1}}. 1024 bytes make a {{u2}}.',
  gaps: [
    { id: 'u1', accept: ['byte'] },
    { id: 'u2', accept: ['kilobyte', 'kibibyte', 'KB'] },
  ],
};

const FREE_MARKS: MarkingInputMarkPoint[] = [mp('byte'), mp('kilobyte')];

function freePart(): MarkingInputPart {
  return { marks: 2, expected_response_type: 'cloze_free', part_config: FREE_CONFIG };
}

describe('markAttemptPart — cloze_free', () => {
  it('all-correct full marks', () => {
    const r = markAttemptPart(freePart(), 'u1=byte\nu2=KB', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('partial credit for one wrong gap', () => {
    const r = markAttemptPart(freePart(), 'u1=bit\nu2=kibibyte', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1);
    expect(r.mark_point_outcomes[0]!.hit).toBe(false);
    expect(r.mark_point_outcomes[1]!.hit).toBe(true);
  });

  it('case-insensitive by default', () => {
    const r = markAttemptPart(freePart(), 'u1=Byte\nu2=KILOBYTE', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('whitespace-trim by default accepts padded answers', () => {
    const r = markAttemptPart(freePart(), 'u1=  byte  \nu2=  KB', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('unknown gap ids in raw_answer are ignored', () => {
    const r = markAttemptPart(freePart(), 'u1=byte\nmystery=foo\nu2=KB', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('blank pupil answer is recorded as zero hits, not a crash', () => {
    const r = markAttemptPart(freePart(), '', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(0);
    expect(r.mark_point_outcomes.every((o) => !o.hit)).toBe(true);
  });

  it('clamps awarded to the part max', () => {
    const small: MarkingInputPart = {
      marks: 1,
      expected_response_type: 'cloze_free',
      part_config: FREE_CONFIG,
    };
    const r = markAttemptPart(small, 'u1=byte\nu2=KB', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1);
  });

  it('teacher_pending when part_config is missing or malformed', () => {
    const noCfg: MarkingInputPart = { marks: 2, expected_response_type: 'cloze_free' };
    expect(markAttemptPart(noCfg, 'u1=byte', FREE_MARKS).kind).toBe('teacher_pending');

    const wrongShape: MarkingInputPart = {
      marks: 2,
      expected_response_type: 'cloze_free',
      part_config: { text: 'no gaps', gaps: [] },
    };
    expect(markAttemptPart(wrongShape, 'u1=byte', FREE_MARKS).kind).toBe('teacher_pending');
  });

  it('emits a normalised_answer with one line per filled gap', () => {
    const r = markAttemptPart(freePart(), 'u1=byte\nu2=KB', FREE_MARKS);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.normalised_answer.split('\n').sort()).toEqual(['u1=byte', 'u2=KB'].sort());
  });
});

describe('markAttemptPart — cloze_with_bank', () => {
  const cfg = {
    text: 'A {{d1}} forwards within a LAN; a {{d2}} between networks.',
    gaps: [
      { id: 'd1', accept: ['switch'] },
      { id: 'd2', accept: ['router'] },
    ],
    bank: ['switch', 'router', 'hub'],
  };

  it('marks correct picks from the bank', () => {
    const part: MarkingInputPart = {
      marks: 2,
      expected_response_type: 'cloze_with_bank',
      part_config: cfg,
    };
    const r = markAttemptPart(part, 'd1=switch\nd2=router', [mp('switch'), mp('router')]);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('teacher_pending when bank is missing', () => {
    const part: MarkingInputPart = {
      marks: 2,
      expected_response_type: 'cloze_with_bank',
      part_config: { ...cfg, bank: undefined },
    };
    expect(markAttemptPart(part, 'd1=switch', [mp('switch')]).kind).toBe('teacher_pending');
  });
});

describe('markAttemptPart — cloze_code', () => {
  const cfg = {
    text: 'for i = 1 to {{stop}}\n  print({{counter}})\nnext i',
    gaps: [
      { id: 'stop', accept: ['5'] },
      { id: 'counter', accept: ['i'] },
    ],
  };

  it('awards both gaps', () => {
    const part: MarkingInputPart = {
      marks: 2,
      expected_response_type: 'cloze_code',
      part_config: cfg,
    };
    const r = markAttemptPart(part, 'stop=5\ncounter=i', [mp('stop'), mp('counter')]);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(2);
  });

  it('values containing "=" round-trip into raw_answer', () => {
    const part: MarkingInputPart = {
      marks: 1,
      expected_response_type: 'cloze_code',
      part_config: {
        text: 'x = {{rhs}}',
        gaps: [{ id: 'rhs', accept: ['2 + 2 = 4'] }],
      },
    };
    const r = markAttemptPart(part, 'rhs=2 + 2 = 4', [mp('expression')]);
    expect(r.kind).toBe('awarded');
    if (r.kind !== 'awarded') return;
    expect(r.marks_awarded).toBe(1);
  });
});
