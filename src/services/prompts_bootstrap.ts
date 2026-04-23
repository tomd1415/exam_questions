import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptVersionRepo } from '../repos/prompts.js';

// Keeps DB rows for the known draft prompts in sync with the markdown
// files under prompts/. Runs once during app bootstrap, after
// migrations. Only creates rows — never overwrites. A row for a given
// (name, version) already present in the DB is considered canonical
// (its status may have been promoted to active or retired by a
// deploy-time migration and the body frozen at that point). Editing
// the .md file on disk after promotion has no effect.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// From src/services/prompts_bootstrap.{ts,js} back to repo root, then
// into prompts/. The dev tsx and the prod dist/ layouts both keep this
// depth consistent so no environment branching is needed.
const DEFAULT_PROMPTS_DIR = resolve(__dirname, '..', '..', 'prompts');

// Family B output schema as a JSON Schema document (draft-07). This is
// what the OpenAI Responses API accepts under Structured Outputs; the
// Zod definition in PROMPTS.md §Family B is the human-readable source
// of truth, and this object must stay in sync. Chunk 3b introduces a
// Zod-to-JSON-Schema translator and a test that asserts they agree;
// until then, editing either one is a code-review checklist item.
// OpenAI Structured Outputs (strict mode) requires every key in
// `properties` to also appear in `required`. Optional fields are
// expressed by giving them a nullable type (`['string', 'null']`)
// rather than omitting them from `required`; the marker in
// services/marking/llm.ts already coalesces nulls via `?? null`.
// Getting this wrong produces HTTP 400 `invalid_json_schema` on every
// real call; this was caught when the first live OpenAI call was
// attempted against the seeded schema — see AUDIT_2026-04-23.md.
export const FAMILY_B_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'marks_awarded',
    'mark_points_hit',
    'mark_points_missed',
    'contradiction_detected',
    'over_answer_detected',
    'confidence',
    'feedback_for_pupil',
    'feedback_for_teacher',
    'refusal',
    'notes',
  ],
  properties: {
    marks_awarded: { type: 'integer', minimum: 0 },
    mark_points_hit: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['mark_point_id', 'evidence_quote'],
        properties: {
          mark_point_id: { type: 'string' },
          evidence_quote: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    mark_points_missed: { type: 'array', items: { type: 'string' } },
    contradiction_detected: { type: 'boolean' },
    over_answer_detected: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    feedback_for_pupil: {
      type: 'object',
      additionalProperties: false,
      required: ['what_went_well', 'how_to_gain_more', 'next_focus'],
      properties: {
        what_went_well: { type: 'string', minLength: 10, maxLength: 300 },
        how_to_gain_more: { type: 'string', minLength: 10, maxLength: 300 },
        next_focus: { type: 'string', minLength: 10, maxLength: 300 },
      },
    },
    feedback_for_teacher: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'suggested_misconception_label', 'suggested_next_question_type'],
      properties: {
        summary: { type: 'string', maxLength: 400 },
        suggested_misconception_label: { type: ['string', 'null'], maxLength: 60 },
        suggested_next_question_type: { type: ['string', 'null'], maxLength: 60 },
      },
    },
    refusal: { type: 'boolean' },
    notes: { type: ['string', 'null'], maxLength: 400 },
  },
} as const;

export interface DraftPromptSpec {
  readonly name: string;
  readonly version: string;
  readonly modelId: string;
  readonly file: string; // relative path under prompts/
  readonly outputSchema: unknown;
}

// Draft rows seeded on fresh DBs. Promotion to `active` is a
// deploy-time migration — do not add an "activate this draft" method
// here. Model ids are placeholders until the eval harness (chunk 3h)
// justifies pinning a specific model per prompt version.
export const KNOWN_DRAFT_PROMPTS: readonly DraftPromptSpec[] = [
  {
    name: 'mark_open_response',
    version: 'v0.1.0',
    modelId: 'gpt-5-mini',
    file: 'mark_open_response/v0.1.0.md',
    outputSchema: FAMILY_B_OUTPUT_SCHEMA,
  },
  {
    name: 'mark_code_response',
    version: 'v0.1.0',
    modelId: 'gpt-5-mini',
    file: 'mark_code_response/v0.1.0.md',
    outputSchema: FAMILY_B_OUTPUT_SCHEMA,
  },
];

export async function seedPromptDraftsFromDisk(
  repo: PromptVersionRepo,
  baseDir: string = DEFAULT_PROMPTS_DIR,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const spec of KNOWN_DRAFT_PROMPTS) {
    const existing = await repo.findByNameAndVersion(spec.name, spec.version);
    if (existing) {
      skipped += 1;
      continue;
    }
    const body = await readFile(resolve(baseDir, spec.file), 'utf8');
    await repo.insert({
      name: spec.name,
      version: spec.version,
      modelId: spec.modelId,
      systemPrompt: body,
      outputSchema: spec.outputSchema,
      status: 'draft',
    });
    inserted += 1;
  }
  return { inserted, skipped };
}
