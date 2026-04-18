import { z } from 'zod';
import {
  EXPECTED_RESPONSE_TYPES,
  SOURCE_TYPES,
  type QuestionDraft,
} from './question-invariants.js';

const ResponseTypeSchema = z.string().refine((v) => EXPECTED_RESPONSE_TYPES.includes(v), {
  message: `Must be one of: ${EXPECTED_RESPONSE_TYPES.join(', ')}`,
});

const SourceTypeSchema = z
  .enum(SOURCE_TYPES as unknown as readonly [string, ...string[]])
  .default('imported_pattern');

export const MarkPointJson = z
  .object({
    text: z.string().trim().min(1).max(1000),
    marks: z.number().int().min(0).default(1),
    required: z.boolean().default(false),
    accepted_alternatives: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const PartMisconceptionJson = z
  .object({
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000),
  })
  .strict();

export const PartJson = z
  .object({
    label: z.string().trim().min(1).max(20),
    prompt: z.string().trim().min(1).max(2000),
    marks: z.number().int().min(0),
    expected_response_type: ResponseTypeSchema,
    // Widget-specific configuration. Shape is validated by the widget
    // registry (src/lib/widgets.ts) at the service boundary, not here —
    // each widget owns its own schema. Null/absent means "no config".
    part_config: z.unknown().nullish(),
    mark_points: z.array(MarkPointJson).min(1),
    misconceptions: z.array(PartMisconceptionJson).default([]),
  })
  .strict();

export const CuratedQuestionJson = z
  .object({
    external_key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/i, {
        message: 'external_key must be a slug (letters, digits, dot, underscore, dash).',
      }),
    component_code: z.string().trim().min(1).max(40),
    topic_code: z.string().trim().min(1).max(20),
    subtopic_code: z.string().trim().min(1).max(20),
    command_word_code: z.string().trim().min(1).max(40),
    archetype_code: z.string().trim().min(1).max(40),
    expected_response_type: ResponseTypeSchema,
    stem: z.string().trim().min(1).max(4000),
    model_answer: z.string().trim().min(1).max(4000),
    feedback_template: z.string().trim().max(4000).nullable().optional(),
    difficulty_band: z.number().int().min(1).max(9),
    difficulty_step: z.number().int().min(1).max(3),
    source_type: SourceTypeSchema,
    review_notes: z.string().trim().max(2000).nullable().optional(),
    parts: z.array(PartJson).min(1),
  })
  .strict();

export type CuratedQuestion = z.infer<typeof CuratedQuestionJson>;

export function toQuestionDraft(q: CuratedQuestion): QuestionDraft {
  return {
    component_code: q.component_code,
    topic_code: q.topic_code,
    subtopic_code: q.subtopic_code,
    command_word_code: q.command_word_code,
    archetype_code: q.archetype_code,
    stem: q.stem,
    expected_response_type: q.expected_response_type,
    model_answer: q.model_answer,
    feedback_template: q.feedback_template ?? null,
    difficulty_band: q.difficulty_band,
    difficulty_step: q.difficulty_step,
    source_type: q.source_type as QuestionDraft['source_type'],
    review_notes: q.review_notes ?? null,
    parts: q.parts.map((p) => ({
      part_label: p.label,
      prompt: p.prompt,
      marks: p.marks,
      expected_response_type: p.expected_response_type,
      part_config: p.part_config ?? null,
      mark_points: p.mark_points.map((mp) => ({
        text: mp.text,
        accepted_alternatives: mp.accepted_alternatives,
        marks: mp.marks,
        is_required: mp.required,
      })),
      misconceptions: p.misconceptions.map((m) => ({
        label: m.label,
        description: m.description,
      })),
    })),
  };
}

export function externalKeyToSimilarityHash(externalKey: string): string {
  return `curated:${externalKey}`;
}
