import { describe, it, expect } from 'vitest';
import { buildPupilAnswerView } from '../../src/lib/pupil-answer-view.js';

// Regression guard for a bug that bit the user on the first day of
// the chunk 3i pilot: teacher marking + admin moderation templates
// rendered image-widget raw_answer payloads (`image=data:image/...`)
// as plain text, so the teacher saw a giant base64 URL instead of
// the drawing. Every future edit to the template answer-render
// logic should keep these branches intact.

describe('buildPupilAnswerView', () => {
  it('returns empty for a null or empty raw_answer', () => {
    expect(buildPupilAnswerView(null, 'flowchart').kind).toBe('empty');
    expect(buildPupilAnswerView('', 'flowchart').kind).toBe('empty');
    expect(buildPupilAnswerView(undefined, 'flowchart').kind).toBe('empty');
  });

  it('detects the flowchart image-variant and extracts the data URL', () => {
    const raw = 'image=data:image/png;base64,AAAA';
    const view = buildPupilAnswerView(raw, 'flowchart');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') {
      expect(view.dataUrl).toBe('data:image/png;base64,AAAA');
      expect(view.alt).toContain('flowchart');
    }
  });

  it('detects the logic_diagram image-variant the same way', () => {
    const raw = 'image=data:image/png;base64,ZZZ';
    const view = buildPupilAnswerView(raw, 'logic_diagram');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') expect(view.alt).toContain('logic_diagram');
  });

  it('tolerates a leading blank line before the image= payload', () => {
    const raw = '\nimage=data:image/png;base64,BB';
    const view = buildPupilAnswerView(raw, 'flowchart');
    expect(view.kind).toBe('image');
  });

  it('falls through to text for every non-image widget', () => {
    const raw = 'r1c1=42\nr1c2=13';
    const view = buildPupilAnswerView(raw, 'trace_table');
    expect(view.kind).toBe('text');
    if (view.kind === 'text') expect(view.text).toBe(raw);
  });

  it('falls through to text for a plain prose answer on an open-response part', () => {
    const raw = 'The CPU fetches and executes instructions.';
    const view = buildPupilAnswerView(raw, 'medium_text');
    expect(view.kind).toBe('text');
  });

  it('does not misclassify a text answer that happens to contain "image=data:" later', () => {
    const raw = 'My answer mentions image=data:image/png which is a thing but it is prose.';
    const view = buildPupilAnswerView(raw, 'medium_text');
    expect(view.kind).toBe('text');
  });
});
