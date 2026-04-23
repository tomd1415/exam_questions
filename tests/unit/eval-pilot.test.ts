import { describe, it, expect } from 'vitest';
import {
  renderPilotCsv,
  renderPilotMarkdown,
  summarisePilot,
  type PilotReviewPair,
} from '../../src/services/eval/pilot.js';

// Chunk 3i. summarisePilot drives the exit-criteria check in
// PHASE3_PLAN.md §5 ("≥ 85% within ±1 mark"); the CSV is what the
// pilot-report script writes to disk. Both must stay structurally
// stable — analysts open the CSV in Excel / Google Sheets and break
// if the column order changes.

function pair(overrides: Partial<PilotReviewPair> = {}): PilotReviewPair {
  return {
    attemptPartId: '10',
    className: 'Year 11 CS',
    pupilPseudonym: 'PUP-001',
    topicCode: '1.2',
    partLabel: '(a)',
    aiMarks: 3,
    teacherMarks: 3,
    marksTotal: 4,
    confidence: 0.88,
    aiPromptVersion: 'mark_open_response@v0.1.0',
    reviewedAt: new Date('2026-05-01T09:30:00Z'),
    reason: 'Both mark points hit — agreement.',
    ...overrides,
  };
}

describe('summarisePilot', () => {
  it('handles an empty input without dividing by zero', () => {
    const summary = summarisePilot([]);
    expect(summary.total).toBe(0);
    expect(summary.meanAbsoluteError).toBe(0);
    expect(summary.withinOneRate).toBe(0);
    expect(summary.offenders).toEqual([]);
  });

  it('counts exact agreement, within ±1, and disagreement ≥ 2 correctly', () => {
    const pairs = [
      pair({ aiMarks: 3, teacherMarks: 3 }), // 0
      pair({ aiMarks: 2, teacherMarks: 3 }), // 1
      pair({ aiMarks: 4, teacherMarks: 3 }), // 1
      pair({ aiMarks: 4, teacherMarks: 1, attemptPartId: '11' }), // 3
      pair({ aiMarks: 0, teacherMarks: 2, attemptPartId: '12' }), // 2
    ];
    const s = summarisePilot(pairs);
    expect(s.total).toBe(5);
    expect(s.exactAgreement).toBe(1);
    expect(s.withinOne).toBe(3);
    expect(s.overTwo).toBe(2);
    expect(s.withinOneRate).toBe(3 / 5);
    expect(s.meanAbsoluteError).toBe((0 + 1 + 1 + 3 + 2) / 5);
    // Offenders sorted by |delta| desc: the 3 comes first.
    expect(s.offenders.map((o) => o.attemptPartId)).toEqual(['11', '12']);
  });

  it('single-item input still reports cleanly', () => {
    const s = summarisePilot([pair({ aiMarks: 2, teacherMarks: 4 })]);
    expect(s.total).toBe(1);
    expect(s.overTwo).toBe(1);
    expect(s.meanAbsoluteError).toBe(2);
    expect(s.withinOneRate).toBe(0);
  });
});

describe('renderPilotCsv', () => {
  it('emits the exact 14-column header the analyst opens in Excel', () => {
    const csv = renderPilotCsv([]);
    const header = csv.split('\n')[0];
    expect(header).toBe(
      'attempt_part_id,class,pupil_pseudonym,topic,part,ai_marks,teacher_marks,marks_total,delta,abs_delta,confidence,prompt_version,reviewed_at,reason',
    );
  });

  it('writes one data row per pair with delta and abs_delta computed', () => {
    const csv = renderPilotCsv([pair({ aiMarks: 1, teacherMarks: 3 })]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    const fields = lines[1]!.split(',');
    // ai_marks=1, teacher_marks=3, delta=2, abs_delta=2
    expect(fields[5]).toBe('1');
    expect(fields[6]).toBe('3');
    expect(fields[8]).toBe('2');
    expect(fields[9]).toBe('2');
  });

  it('quotes reasons containing commas, quotes, and newlines', () => {
    const csv = renderPilotCsv([
      pair({ reason: 'Covered mp_1, mp_2; "seen" and\nmentioned both.' }),
    ]);
    // The reason field contains an embedded newline, so splitting
    // on '\n' is unsafe. Assert the exact escaped quoted form is
    // present anywhere in the output: commas pass through, inner
    // double-quotes become "", and the whole field is wrapped.
    expect(csv).toContain('"Covered mp_1, mp_2; ""seen"" and\nmentioned both."');
  });

  it('emits empty cells for null confidence / topic / prompt version', () => {
    const csv = renderPilotCsv([
      pair({ confidence: null, topicCode: null, aiPromptVersion: null }),
    ]);
    const row = csv.trim().split('\n')[1]!;
    const fields = row.split(',');
    // topic, confidence, prompt_version columns.
    expect(fields[3]).toBe('');
    expect(fields[10]).toBe('');
    expect(fields[11]).toBe('');
  });
});

describe('renderPilotMarkdown', () => {
  it('flags PASS when within-one rate clears 85%', () => {
    const pairs = [
      pair({ aiMarks: 2, teacherMarks: 2 }),
      pair({ aiMarks: 3, teacherMarks: 3 }),
      pair({ aiMarks: 4, teacherMarks: 4 }),
      pair({ aiMarks: 1, teacherMarks: 2 }),
      pair({ aiMarks: 2, teacherMarks: 1 }),
    ];
    const md = renderPilotMarkdown(summarisePilot(pairs), new Date('2026-05-08T12:00:00Z'));
    expect(md).toMatch(/≥ 85% within ±1 mark: PASS/);
  });

  it('flags FAIL when the rate drops below 85%', () => {
    const pairs = [
      pair({ aiMarks: 4, teacherMarks: 1 }),
      pair({ aiMarks: 4, teacherMarks: 1, attemptPartId: '11' }),
      pair({ aiMarks: 1, teacherMarks: 1, attemptPartId: '12' }),
    ];
    const md = renderPilotMarkdown(summarisePilot(pairs), new Date('2026-05-08T12:00:00Z'));
    expect(md).toMatch(/≥ 85% within ±1 mark: FAIL/);
    expect(md).toMatch(/\|AI − teacher\| ≥ 2/);
  });

  it('omits the offenders section when none exist', () => {
    const pairs = [pair({ aiMarks: 3, teacherMarks: 3 })];
    const md = renderPilotMarkdown(summarisePilot(pairs), new Date('2026-05-08T12:00:00Z'));
    expect(md).not.toMatch(/\|AI − teacher\| ≥ 2/);
  });
});
