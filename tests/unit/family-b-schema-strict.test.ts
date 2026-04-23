import { describe, it, expect } from 'vitest';
import { FAMILY_B_OUTPUT_SCHEMA } from '../../src/services/prompts_bootstrap.js';

// Regression guard for the Structured Outputs schema. OpenAI strict
// mode rejects any object whose `properties` set is larger than its
// `required` set — the first live call against an under-specified
// schema returns HTTP 400 `invalid_json_schema`. The previous
// `mark_open_response v0.1.0` schema shipped with three optional
// properties missing from `required` and that bug survived every
// stub-based test, so a latent failure only surfaced on the first
// real-world OpenAI call. See AUDIT_2026-04-23.md §Latent bug.
//
// This test walks the schema tree and asserts the strict-mode rules
// locally, without any network. A future edit to FAMILY_B_OUTPUT_SCHEMA
// that reintroduces the bug will now fail here, not in production.
//
// Rules enforced (from OpenAI Structured Outputs docs):
//   1. Every object has `additionalProperties: false`.
//   2. Every key in `properties` is also in `required`.
//   3. Optional fields are modelled by `type: ['<type>', 'null']`,
//      not by being omitted from `required`.

interface JsonSchema {
  type?: string | readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

function walk(schema: JsonSchema, path: string, violations: string[]): void {
  const type = Array.isArray(schema.type) ? schema.type : [schema.type];

  if (type.includes('object')) {
    if (schema.additionalProperties !== false) {
      violations.push(`${path}: object must set additionalProperties: false`);
    }
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) {
        violations.push(
          `${path}.${key}: present in properties but missing from required (OpenAI strict mode rejects this)`,
        );
      }
    }
    for (const [key, child] of Object.entries(props)) {
      walk(child, `${path}.${key}`, violations);
    }
  }

  if (type.includes('array') && schema.items) {
    walk(schema.items, `${path}[]`, violations);
  }
}

describe('FAMILY_B_OUTPUT_SCHEMA — OpenAI strict-mode conformance', () => {
  it('has every `properties` key in `required` at every nesting level', () => {
    const violations: string[] = [];
    walk(FAMILY_B_OUTPUT_SCHEMA as unknown as JsonSchema, '$', violations);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('uses the nullable-type encoding for the known-optional fields', () => {
    // Spot-check the three specific fields that previously regressed.
    // If these ever stop being nullable, either the LLM will start
    // returning non-null values the schema no longer allows, or the
    // fields stopped being optional — both need a conscious review.
    const props = (FAMILY_B_OUTPUT_SCHEMA as unknown as JsonSchema).properties!;
    const notesType = props['notes']!.type;
    expect(Array.isArray(notesType) ? notesType : [notesType]).toContain('null');

    const teacher = props['feedback_for_teacher']!.properties!;
    for (const key of ['suggested_misconception_label', 'suggested_next_question_type']) {
      const t = teacher[key]!.type;
      expect(Array.isArray(t) ? t : [t], `feedback_for_teacher.${key} must be nullable`).toContain(
        'null',
      );
    }
  });
});
