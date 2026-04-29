import { describe, it, expect } from 'vitest';
import { buildPupilAnswerView } from '../../src/lib/pupil-answer-view.js';

// Regression guard for a bug that bit the user on the first day of
// the chunk 3i pilot: teacher marking + admin moderation templates
// rendered widget raw_answer payloads (image data-URLs and encoded
// `key=value` lines) as plain text, so the teacher saw either a
// giant base64 URL or a pile of numbers instead of the drawing /
// the pupil's decoded selections. Every future edit to the view
// should keep these branches intact.

describe('buildPupilAnswerView — empty / image branches', () => {
  it('returns empty for a null, undefined, or empty raw_answer', () => {
    expect(buildPupilAnswerView(null, 'flowchart').kind).toBe('empty');
    expect(buildPupilAnswerView('', 'flowchart').kind).toBe('empty');
    expect(buildPupilAnswerView(undefined, 'flowchart').kind).toBe('empty');
  });

  it('detects flowchart image-variant and extracts the data URL', () => {
    const view = buildPupilAnswerView('image=data:image/png;base64,AAAA', 'flowchart');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') {
      expect(view.dataUrl).toBe('data:image/png;base64,AAAA');
      expect(view.alt).toContain('flowchart');
    }
  });

  it('detects logic_diagram image-variant the same way', () => {
    const view = buildPupilAnswerView('image=data:image/png;base64,ZZZ', 'logic_diagram');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') expect(view.alt).toContain('logic_diagram');
  });

  it('tolerates a leading blank line before image=', () => {
    expect(buildPupilAnswerView('\nimage=data:image/png;base64,BB', 'flowchart').kind).toBe(
      'image',
    );
  });

  it('does not misclassify prose that mentions "image=data:" later', () => {
    const view = buildPupilAnswerView(
      'My answer mentions image=data:image/png somewhere in prose.',
      'medium_text',
    );
    expect(view.kind).toBe('text');
  });

  // Defence in depth for older pupil answers (pre-pilot data on the
  // production DB). The current widget editors always emit
  // `image=data:image/png;base64,…`, but earlier widget versions or a
  // future canvas variant might omit the `image=` prefix or use a
  // different MIME type — a teacher should still see a drawing, not
  // a base64 wall. A drift-detector that 'just rendered' anything
  // starting with `data:` would be unsafe (a pupil could paste a
  // genuine prose `data:` and get a broken image), so we restrict to
  // a known MIME-type whitelist. See pupil-answer-view.ts for the
  // canonical rule.
  it('detects bare data:image/png (no `image=` prefix)', () => {
    const view = buildPupilAnswerView('data:image/png;base64,QUJD', 'flowchart');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') expect(view.dataUrl).toBe('data:image/png;base64,QUJD');
  });

  it('accepts the JPEG MIME type', () => {
    const view = buildPupilAnswerView('image=data:image/jpeg;base64,/9j/4AAQ', 'logic_diagram');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') expect(view.dataUrl).toBe('data:image/jpeg;base64,/9j/4AAQ');
  });

  it('accepts SVG (utf8 inline) — common when widgets emit a vector drawing', () => {
    const svgUrl = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>";
    const view = buildPupilAnswerView(svgUrl, 'flowchart');
    expect(view.kind).toBe('image');
    if (view.kind === 'image') expect(view.dataUrl).toBe(svgUrl);
  });

  it('accepts WebP and GIF', () => {
    expect(buildPupilAnswerView('image=data:image/webp;base64,UkVQRg==', 'flowchart').kind).toBe(
      'image',
    );
    expect(buildPupilAnswerView('data:image/gif;base64,R0lGODlhAQA=', 'flowchart').kind).toBe(
      'image',
    );
  });

  it('does NOT render `data:image/foo;base64,…` for an unknown MIME type', () => {
    // Falling through to text is safer than rendering a broken <img>
    // that hides the raw payload from the teacher entirely.
    const view = buildPupilAnswerView('data:image/x-unknown;base64,AAAA', 'medium_text');
    expect(view.kind).toBe('text');
  });
});

describe('buildPupilAnswerView — matching', () => {
  const cfg = {
    left: ['Sodium', 'Iron', 'Oxygen'],
    right: ['Metal', 'Non-metal', 'Alkali metal'],
    correctPairs: [
      [0, 2],
      [1, 0],
      [2, 1],
    ],
  };

  it('returns the matching kind with full left + right columns plus the pupil pairs', () => {
    const view = buildPupilAnswerView('0=2\n1=0\n2=1', 'matching', cfg);
    expect(view.kind).toBe('matching');
    if (view.kind === 'matching') {
      expect(view.leftLabels).toEqual(cfg.left);
      expect(view.rightLabels).toEqual(cfg.right);
      expect(view.pairs).toEqual([
        { leftLabel: 'Sodium', chosenRight: 'Alkali metal' },
        { leftLabel: 'Iron', chosenRight: 'Metal' },
        { leftLabel: 'Oxygen', chosenRight: 'Non-metal' },
      ]);
    }
  });

  it('marks un-paired left rows as chosenRight=null', () => {
    const view = buildPupilAnswerView('0=2', 'matching', cfg);
    if (view.kind === 'matching') {
      expect(view.pairs[0]!.chosenRight).toBe('Alkali metal');
      expect(view.pairs[1]!.chosenRight).toBeNull();
      expect(view.pairs[2]!.chosenRight).toBeNull();
    }
  });

  it('falls through to text when part_config is missing or malformed', () => {
    expect(buildPupilAnswerView('0=2', 'matching', null).kind).toBe('text');
    expect(buildPupilAnswerView('0=2', 'matching', { left: 'not-an-array' }).kind).toBe('text');
  });
});

describe('buildPupilAnswerView — matrix_tick_single', () => {
  const cfg = {
    rows: ['Stores data while the computer is on', 'Retains data when power is removed'],
    columns: ['RAM', 'ROM', 'SSD'],
    correctByRow: ['RAM', 'ROM'],
  };

  it('decodes each row into (row-label, selected-column)', () => {
    const view = buildPupilAnswerView('0=RAM\n1=ROM', 'matrix_tick_single', cfg);
    if (view.kind === 'rows') {
      expect(view.rows[0]).toEqual({
        label: 'Stores data while the computer is on',
        value: 'RAM',
        blank: false,
      });
      expect(view.rows[1]!.value).toBe('ROM');
    }
  });

  it('marks a row with no selection as blank', () => {
    const view = buildPupilAnswerView('0=RAM', 'matrix_tick_single', cfg);
    if (view.kind === 'rows') {
      expect(view.rows[1]!.blank).toBe(true);
    }
  });
});

describe('buildPupilAnswerView — matrix_tick_multi', () => {
  const cfg = {
    rows: ['Volatile', 'Primary storage'],
    columns: ['RAM', 'ROM', 'SSD'],
  };

  it('decodes CSV-style selections into a human-readable string', () => {
    const view = buildPupilAnswerView('0=RAM\n1=RAM,ROM', 'matrix_tick_multi', cfg);
    if (view.kind === 'rows') {
      expect(view.rows[0]!.value).toBe('RAM');
      expect(view.rows[1]!.value).toBe('RAM, ROM');
    }
  });
});

describe('buildPupilAnswerView — diagram_labels', () => {
  const cfg = {
    imageUrl: '/static/img/cpu.png',
    imageAlt: 'CPU diagram',
    width: 400,
    height: 300,
    hotspots: [
      { id: 'alu', x: 10, y: 10, width: 50, height: 20, accept: ['ALU'] },
      { id: 'cu', x: 70, y: 10, width: 50, height: 20, accept: ['Control Unit'] },
    ],
  };

  it('returns the diagram-labels kind with the source image, dimensions, and hotspot positions', () => {
    const view = buildPupilAnswerView('alu=ALU\ncu=Control Unit', 'diagram_labels', cfg);
    expect(view.kind).toBe('diagram-labels');
    if (view.kind === 'diagram-labels') {
      expect(view.imageUrl).toBe('/static/img/cpu.png');
      expect(view.width).toBe(400);
      expect(view.height).toBe(300);
      expect(view.hotspots[0]).toEqual({
        id: 'alu',
        x: 10,
        y: 10,
        width: 50,
        height: 20,
        value: 'ALU',
      });
      expect(view.hotspots[1]!.value).toBe('Control Unit');
    }
  });

  it('marks unlabelled hotspots as value=null', () => {
    const view = buildPupilAnswerView('alu=ALU', 'diagram_labels', cfg);
    if (view.kind === 'diagram-labels') {
      expect(view.hotspots[0]!.value).toBe('ALU');
      expect(view.hotspots[1]!.value).toBeNull();
    }
  });

  it('falls through to text when imageUrl or dimensions are missing', () => {
    const broken = { ...cfg, width: 'not-a-number' as unknown as number };
    expect(buildPupilAnswerView('alu=ALU', 'diagram_labels', broken).kind).toBe('text');
  });
});

describe('buildPupilAnswerView — cloze', () => {
  const cfg = {
    text: 'The CPU fetches an {{gap-instr}} from {{gap-mem}}.',
    gaps: [
      { id: 'gap-instr', accept: ['instruction'] },
      { id: 'gap-mem', accept: ['RAM', 'memory'] },
    ],
  };

  it('returns the cloze kind with the prose split into segments and pupil values inlined', () => {
    const view = buildPupilAnswerView('gap-instr=instruction\ngap-mem=RAM', 'cloze_free', cfg);
    expect(view.kind).toBe('cloze');
    if (view.kind === 'cloze') {
      // Segments: "The CPU fetches an " (text) → gap(gap-instr=instruction) →
      // " from " (text) → gap(gap-mem=RAM) → "." (text).
      expect(view.segments).toEqual([
        { kind: 'text', text: 'The CPU fetches an ' },
        { kind: 'gap', id: 'gap-instr', value: 'instruction' },
        { kind: 'text', text: ' from ' },
        { kind: 'gap', id: 'gap-mem', value: 'RAM' },
        { kind: 'text', text: '.' },
      ]);
    }
  });

  it('records value=null for blank gaps so the template can render a placeholder', () => {
    const view = buildPupilAnswerView('gap-instr=instruction', 'cloze_with_bank', {
      ...cfg,
      bank: ['instruction', 'RAM'],
    });
    if (view.kind === 'cloze') {
      const gaps = view.segments.filter((s) => s.kind === 'gap');
      expect(gaps[0]!.value).toBe('instruction');
      expect(gaps[1]!.value).toBeNull();
      expect(view.bank).toEqual(['instruction', 'RAM']);
    }
  });

  it('falls through to text when the cloze prose is malformed (mismatched braces)', () => {
    const view = buildPupilAnswerView('gap-instr=instruction', 'cloze_free', {
      text: 'broken {{gap-instr without closing',
      gaps: cfg.gaps,
    });
    expect(view.kind).toBe('text');
  });
});

describe('buildPupilAnswerView — trace_table', () => {
  const cfg = {
    rows: 2,
    columns: [{ name: 'i' }, { name: 'sum' }],
    prefill: { '0,0': '0' },
    expected: { '0,1': '0', '1,0': '1', '1,1': '1' },
    marking: { mode: 'perCell' },
  };

  it('emits a 2D grid with pupil cells + prefilled cells flagged', () => {
    const view = buildPupilAnswerView('0,1=0\n1,0=1\n1,1=1', 'trace_table', cfg);
    expect(view.kind).toBe('grid');
    if (view.kind === 'grid') {
      expect(view.columns).toEqual(['i', 'sum']);
      expect(view.rows[0]![0]).toEqual({ value: '0', blank: false, prefilled: true });
      expect(view.rows[0]![1]).toEqual({ value: '0', blank: false, prefilled: false });
      expect(view.rows[1]![0]!.value).toBe('1');
      expect(view.rows[1]![1]!.value).toBe('1');
    }
  });

  it('marks missing pupil cells as blank', () => {
    const view = buildPupilAnswerView('1,0=1', 'trace_table', cfg);
    if (view.kind === 'grid') {
      // (0,1) is neither prefilled nor typed by the pupil.
      expect(view.rows[0]![1]!.blank).toBe(true);
      // (1,1) is also left blank.
      expect(view.rows[1]![1]!.blank).toBe(true);
    }
  });
});

describe('buildPupilAnswerView — fallback', () => {
  it('falls through to text for every non-widget response type', () => {
    expect(buildPupilAnswerView('The CPU fetches instructions.', 'medium_text').kind).toBe('text');
    expect(buildPupilAnswerView('print("hi")', 'code').kind).toBe('text');
  });

  it('falls through to text when a widget type has no part_config', () => {
    expect(buildPupilAnswerView('0=1', 'matching').kind).toBe('text');
  });
});
