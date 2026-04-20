import { describe, it, expect } from 'vitest';
import {
  validateQuestionDraft,
  validateModelAnswerShape,
  canTransition,
  type QuestionDraft,
  type QuestionDraftReferenceData,
} from '../../src/lib/question-invariants.js';

const REFS: QuestionDraftReferenceData = {
  commandWords: new Set(['describe', 'explain', 'state']),
  archetypes: new Set(['recall', 'explain']),
  components: new Set(['J277/01', 'J277/02']),
  topicComponent: new Map([
    ['1.1', 'J277/01'],
    ['1.2', 'J277/01'],
    ['2.1', 'J277/02'],
  ]),
  subtopicTopic: new Map([
    ['1.1.1', '1.1'],
    ['1.2.1', '1.2'],
    ['2.1.1', '2.1'],
  ]),
};

function goodDraft(): QuestionDraft {
  return {
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
    command_word_code: 'describe',
    archetype_code: 'explain',
    stem: 'Describe the CPU.',
    expected_response_type: 'short_text',
    model_answer: 'The CPU executes instructions.',
    feedback_template: null,
    difficulty_band: 3,
    difficulty_step: 1,
    source_type: 'teacher',
    review_notes: null,
    parts: [
      {
        part_label: '(a)',
        prompt: 'Name one component.',
        marks: 1,
        expected_response_type: 'short_text',
        mark_points: [
          {
            text: 'ALU',
            accepted_alternatives: [],
            marks: 1,
            is_required: false,
          },
        ],
        misconceptions: [],
      },
    ],
  };
}

describe('validateQuestionDraft — happy path', () => {
  it('accepts a minimal well-formed draft and computes marks_total', () => {
    const r = validateQuestionDraft(goodDraft(), REFS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.marks_total).toBe(1);
      expect(r.value.parts).toHaveLength(1);
    }
  });

  it('computes marks_total as the sum of part marks across multiple parts', () => {
    const d = goodDraft();
    d.parts = [
      {
        part_label: '(a)',
        prompt: 'First.',
        marks: 2,
        expected_response_type: 'short_text',
        mark_points: [{ text: 'x', accepted_alternatives: [], marks: 1, is_required: false }],
        misconceptions: [],
      },
      {
        part_label: '(b)',
        prompt: 'Second.',
        marks: 3,
        expected_response_type: 'short_text',
        mark_points: [{ text: 'y', accepted_alternatives: [], marks: 1, is_required: false }],
        misconceptions: [],
      },
    ];
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.marks_total).toBe(5);
  });

  it('trims leading/trailing whitespace from strings and drops empty alternatives', () => {
    const d = goodDraft();
    d.stem = '   Describe the CPU.   ';
    d.parts[0]!.mark_points[0]!.accepted_alternatives = ['  alt 1  ', '   ', ''];
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stem).toBe('Describe the CPU.');
      expect(r.value.parts[0]!.mark_points[0]!.accepted_alternatives).toEqual(['alt 1']);
    }
  });
});

describe('validateQuestionDraft — structural invariants', () => {
  it('rejects a draft with no parts', () => {
    const d = goodDraft();
    d.parts = [];
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'parts')).toBe(true);
  });

  it('rejects a part with zero mark points', () => {
    const d = goodDraft();
    d.parts[0]!.mark_points = [];
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'parts.0.mark_points')).toBe(true);
  });

  it('rejects duplicate part labels', () => {
    const d = goodDraft();
    d.parts = [
      {
        part_label: '(a)',
        prompt: 'First.',
        marks: 1,
        expected_response_type: 'short_text',
        mark_points: [{ text: 'x', accepted_alternatives: [], marks: 1, is_required: false }],
        misconceptions: [],
      },
      {
        part_label: '(a)',
        prompt: 'Second.',
        marks: 1,
        expected_response_type: 'short_text',
        mark_points: [{ text: 'y', accepted_alternatives: [], marks: 1, is_required: false }],
        misconceptions: [],
      },
    ];
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'parts.1.part_label')).toBe(true);
  });

  it('rejects a negative or non-integer part marks value', () => {
    const d = goodDraft();
    d.parts[0]!.marks = -1;
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'parts.0.marks')).toBe(true);
  });

  it('rejects empty stem, prompt, mark-point text', () => {
    const d = goodDraft();
    d.stem = '   ';
    d.parts[0]!.prompt = '';
    d.parts[0]!.mark_points[0]!.text = '';
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'stem')).toBe(true);
      expect(r.issues.some((i) => i.path === 'parts.0.prompt')).toBe(true);
      expect(r.issues.some((i) => i.path === 'parts.0.mark_points.0.text')).toBe(true);
    }
  });
});

describe('validateQuestionDraft — reference-data lookups', () => {
  it('rejects an unknown command_word', () => {
    const d = goodDraft();
    d.command_word_code = 'NOT_A_REAL_CMD';
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'command_word_code')).toBe(true);
  });

  it('rejects an unknown archetype', () => {
    const d = goodDraft();
    d.archetype_code = 'NOT_AN_ARCHETYPE';
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'archetype_code')).toBe(true);
  });

  it('rejects a subtopic that does not belong to the declared topic', () => {
    const d = goodDraft();
    d.topic_code = '1.2';
    d.subtopic_code = '1.1.1'; // belongs to 1.1, not 1.2
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'subtopic_code')).toBe(true);
  });

  it('rejects a topic that does not belong to the declared component', () => {
    const d = goodDraft();
    d.component_code = 'J277/02';
    d.topic_code = '1.1'; // belongs to J277/01
    d.subtopic_code = '1.1.1';
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path === 'topic_code')).toBe(true);
  });

  it('rejects an unknown expected_response_type at question and part levels', () => {
    const d = goodDraft();
    d.expected_response_type = 'zombie_type';
    d.parts[0]!.expected_response_type = 'zombie_type';
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'expected_response_type')).toBe(true);
      expect(r.issues.some((i) => i.path === 'parts.0.expected_response_type')).toBe(true);
    }
  });
});

describe('validateQuestionDraft — numeric ranges', () => {
  it('rejects difficulty_band outside 1..9', () => {
    const d = goodDraft();
    d.difficulty_band = 10;
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
  });

  it('rejects difficulty_step outside 1..3', () => {
    const d = goodDraft();
    d.difficulty_step = 0;
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
  });
});

describe('canTransition', () => {
  it('allows draft → pending_review, approved, archived', () => {
    expect(canTransition('draft', 'pending_review')).toBe(true);
    expect(canTransition('draft', 'approved')).toBe(true);
    expect(canTransition('draft', 'archived')).toBe(true);
  });

  it('allows pending_review → approved, rejected, draft', () => {
    expect(canTransition('pending_review', 'approved')).toBe(true);
    expect(canTransition('pending_review', 'rejected')).toBe(true);
    expect(canTransition('pending_review', 'draft')).toBe(true);
  });

  it('only allows approved → archived', () => {
    expect(canTransition('approved', 'archived')).toBe(true);
    expect(canTransition('approved', 'draft')).toBe(false);
    expect(canTransition('approved', 'pending_review')).toBe(false);
  });

  it('rejects transitions from unknown states and to the same state', () => {
    expect(canTransition('draft', 'draft')).toBe(false);
    expect(canTransition('mystery', 'approved')).toBe(false);
  });
});

describe('validateModelAnswerShape (Chunk B1)', () => {
  it('accepts any non-empty prose for teacher-review widgets', () => {
    for (const t of ['short_text', 'medium_text', 'extended_response', 'code', 'algorithm']) {
      expect(validateModelAnswerShape(t, 'any free prose', null)).toEqual([]);
    }
  });

  it('multiple_choice: model answer must appear in options', () => {
    const cfg = { options: ['A', 'B', 'C'] };
    expect(validateModelAnswerShape('multiple_choice', 'A', cfg)).toEqual([]);
    const issues = validateModelAnswerShape('multiple_choice', 'D', cfg);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('tick_box: requires JSON array of option strings', () => {
    const cfg = { options: ['A', 'B', 'C'] };
    expect(validateModelAnswerShape('tick_box', '["A","B"]', cfg)).toEqual([]);
    expect(validateModelAnswerShape('tick_box', 'prose', cfg).length).toBeGreaterThan(0);
    expect(validateModelAnswerShape('tick_box', '["A","D"]', cfg).length).toBeGreaterThan(0);
  });

  it('matching: requires JSON array of [leftIdx, rightIdx] pairs', () => {
    expect(validateModelAnswerShape('matching', '[[0,0],[1,1]]', null)).toEqual([]);
    expect(
      validateModelAnswerShape('matching', 'HTTP → web pages, SMTP → email', null).length,
    ).toBeGreaterThan(0);
    expect(validateModelAnswerShape('matching', '[[0],[1]]', null).length).toBeGreaterThan(0);
  });

  it('cloze_free: requires JSON object covering every gap id', () => {
    const cfg = {
      text: '{{g1}} and {{g2}}',
      gaps: [
        { id: 'g1', accept: ['x'] },
        { id: 'g2', accept: ['y'] },
      ],
    };
    expect(validateModelAnswerShape('cloze_free', '{"g1":"x","g2":"y"}', cfg)).toEqual([]);
    expect(validateModelAnswerShape('cloze_free', '{"g1":"x"}', cfg).length).toBeGreaterThan(0);
    expect(validateModelAnswerShape('cloze_free', 'prose answer', cfg).length).toBeGreaterThan(0);
  });

  it('matrix_tick_single: requires JSON row→column covering all rows with valid columns', () => {
    const cfg = { rows: ['R1', 'R2'], columns: ['A', 'B'] };
    expect(validateModelAnswerShape('matrix_tick_single', '{"R1":"A","R2":"B"}', cfg)).toEqual([]);
    expect(
      validateModelAnswerShape('matrix_tick_single', '{"R1":"Z","R2":"B"}', cfg).length,
    ).toBeGreaterThan(0);
    expect(
      validateModelAnswerShape('matrix_tick_single', '{"R1":"A"}', cfg).length,
    ).toBeGreaterThan(0);
  });

  it('matrix_tick_multi: each row value must be an array of column strings', () => {
    const cfg = { rows: ['R1', 'R2'], columns: ['A', 'B'] };
    expect(
      validateModelAnswerShape('matrix_tick_multi', '{"R1":["A"],"R2":["A","B"]}', cfg),
    ).toEqual([]);
    expect(validateModelAnswerShape('matrix_tick_multi', '{"R1":"A"}', cfg).length).toBeGreaterThan(
      0,
    );
  });

  it('trace_table: keys must match the "row,col" pattern', () => {
    expect(validateModelAnswerShape('trace_table', '{"0,0":"1","1,0":"2"}', null)).toEqual([]);
    expect(validateModelAnswerShape('trace_table', '{"row0":"1"}', null).length).toBeGreaterThan(0);
  });

  it('diagram_labels: JSON object must cover every hotspot id', () => {
    const cfg = { hotspots: [{ id: 'a' }, { id: 'b' }] };
    expect(validateModelAnswerShape('diagram_labels', '{"a":"top","b":"bottom"}', cfg)).toEqual([]);
    expect(validateModelAnswerShape('diagram_labels', '{"a":"top"}', cfg).length).toBeGreaterThan(
      0,
    );
  });

  it('logic_diagram + flowchart accept any non-empty prose for now', () => {
    expect(validateModelAnswerShape('logic_diagram', 'diagram attached', null)).toEqual([]);
    expect(validateModelAnswerShape('flowchart', 'flowchart attached', null)).toEqual([]);
  });

  it('fires through validateQuestionDraft when a single-part widget uses prose where JSON is required', () => {
    const d: QuestionDraft = {
      component_code: 'J277/01',
      topic_code: '1.1',
      subtopic_code: '1.1.1',
      command_word_code: 'describe',
      archetype_code: 'recall',
      stem: 'Match each item.',
      expected_response_type: 'matching',
      model_answer: 'HTTP — web pages, SMTP — email',
      feedback_template: null,
      difficulty_band: 3,
      difficulty_step: 1,
      source_type: 'teacher',
      review_notes: null,
      parts: [
        {
          part_label: '(a)',
          prompt: 'Pair them.',
          marks: 2,
          expected_response_type: 'matching',
          part_config: {
            left: ['HTTP', 'SMTP'],
            right: ['web pages', 'email'],
            correctPairs: [
              [0, 0],
              [1, 1],
            ],
          },
          mark_points: [
            { text: 'HTTP — web pages', accepted_alternatives: [], marks: 1, is_required: false },
            { text: 'SMTP — email', accepted_alternatives: [], marks: 1, is_required: false },
          ],
          misconceptions: [],
        },
      ],
    };
    const r = validateQuestionDraft(d, REFS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'model_answer')).toBe(true);
    }
  });
});
