import { describe, it, expect } from 'vitest';
import {
  CuratedQuestionJson,
  externalKeyToSimilarityHash,
  toQuestionDraft,
} from '../../src/lib/content-schema.js';

function validFixture(): unknown {
  return {
    external_key: 'j277-1.1-alu-purpose',
    component_code: 'J277/01',
    topic_code: '1.1',
    subtopic_code: '1.1.1',
    command_word_code: 'describe',
    archetype_code: 'explain',
    expected_response_type: 'short_text',
    stem: 'Inside the CPU is the Arithmetic Logic Unit (ALU).',
    model_answer:
      'The ALU performs arithmetic operations (addition, subtraction) and logical operations (AND, OR, NOT, comparisons).',
    difficulty_band: 4,
    difficulty_step: 2,
    source_type: 'imported_pattern',
    parts: [
      {
        label: '(a)',
        prompt: 'Describe the purpose of the ALU.',
        marks: 2,
        expected_response_type: 'short_text',
        mark_points: [
          { text: 'performs arithmetic operations', marks: 1 },
          { text: 'performs logical operations', marks: 1 },
        ],
      },
    ],
  };
}

describe('CuratedQuestionJson', () => {
  it('accepts a valid curated question', () => {
    const result = CuratedQuestionJson.safeParse(validFixture());
    expect(result.success).toBe(true);
  });

  it('defaults source_type and optional fields', () => {
    const fx = validFixture() as Record<string, unknown>;
    delete fx['source_type'];
    const result = CuratedQuestionJson.safeParse(fx);
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.source_type).toBe('imported_pattern');
    expect(result.data.feedback_template ?? null).toBeNull();
    expect(result.data.review_notes ?? null).toBeNull();
  });

  it('requires at least one part with at least one mark point', () => {
    const fx = validFixture() as Record<string, unknown>;
    fx['parts'] = [];
    const r1 = CuratedQuestionJson.safeParse(fx);
    expect(r1.success).toBe(false);

    const fx2 = validFixture() as {
      parts: { mark_points: unknown[] }[];
    };
    fx2.parts[0]!.mark_points = [];
    const r2 = CuratedQuestionJson.safeParse(fx2);
    expect(r2.success).toBe(false);
  });

  it('rejects unknown expected_response_type', () => {
    const fx = validFixture() as Record<string, unknown>;
    fx['expected_response_type'] = 'paragraph';
    const result = CuratedQuestionJson.safeParse(fx);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(';');
      expect(msg).toMatch(/multiple_choice/);
    }
  });

  it('rejects negative or fractional marks', () => {
    const fx = validFixture() as { parts: { marks: number }[] };
    fx.parts[0]!.marks = -1;
    expect(CuratedQuestionJson.safeParse(fx).success).toBe(false);

    const fx2 = validFixture() as { parts: { marks: number }[] };
    fx2.parts[0]!.marks = 1.5;
    expect(CuratedQuestionJson.safeParse(fx2).success).toBe(false);
  });

  it('rejects difficulty_band out of range', () => {
    const fx = validFixture() as { difficulty_band: number };
    fx.difficulty_band = 12;
    expect(CuratedQuestionJson.safeParse(fx).success).toBe(false);
  });

  it('rejects empty stem and model_answer after trim', () => {
    const fx = validFixture() as { stem: string; model_answer: string };
    fx.stem = '   ';
    expect(CuratedQuestionJson.safeParse(fx).success).toBe(false);

    const fx2 = validFixture() as { stem: string; model_answer: string };
    fx2.model_answer = '';
    expect(CuratedQuestionJson.safeParse(fx2).success).toBe(false);
  });

  it('rejects a slug with spaces or disallowed characters', () => {
    const fx = validFixture() as { external_key: string };
    fx.external_key = 'bad key with spaces';
    expect(CuratedQuestionJson.safeParse(fx).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const fx = validFixture() as Record<string, unknown>;
    fx['extra_field'] = 'nope';
    expect(CuratedQuestionJson.safeParse(fx).success).toBe(false);
  });
});

describe('toQuestionDraft', () => {
  it('maps JSON fields onto QuestionDraft shape', () => {
    const parsed = CuratedQuestionJson.parse(validFixture());
    const draft = toQuestionDraft(parsed);
    expect(draft.component_code).toBe('J277/01');
    expect(draft.parts).toHaveLength(1);
    expect(draft.parts[0]!.part_label).toBe('(a)');
    expect(draft.parts[0]!.mark_points).toHaveLength(2);
    expect(draft.parts[0]!.mark_points[0]!.marks).toBe(1);
    expect(draft.parts[0]!.mark_points[0]!.is_required).toBe(false);
    expect(draft.feedback_template).toBeNull();
    expect(draft.review_notes).toBeNull();
  });

  it('carries accepted_alternatives and required flag through', () => {
    const fx = validFixture() as {
      parts: {
        mark_points: {
          text: string;
          marks?: number;
          required?: boolean;
          accepted_alternatives?: string[];
        }[];
      }[];
    };
    fx.parts[0]!.mark_points[0]!.required = true;
    fx.parts[0]!.mark_points[0]!.accepted_alternatives = ['ALU', 'arithmetic-logic unit'];
    const parsed = CuratedQuestionJson.parse(fx);
    const draft = toQuestionDraft(parsed);
    expect(draft.parts[0]!.mark_points[0]!.is_required).toBe(true);
    expect(draft.parts[0]!.mark_points[0]!.accepted_alternatives).toEqual([
      'ALU',
      'arithmetic-logic unit',
    ]);
  });
});

describe('externalKeyToSimilarityHash', () => {
  it('namespaces the key with curated: prefix', () => {
    expect(externalKeyToSimilarityHash('abc')).toBe('curated:abc');
  });
});
