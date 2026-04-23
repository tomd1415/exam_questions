import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Chunk 3h. Golden fixtures for the nightly prompt eval harness.
// Each fixture is a single JSON file under prompts/eval/<prompt_name>/.
// The shape mirrors LlmMarkingInput so the runner can hand the fixture
// straight to LlmOpenResponseMarker without adapter code. The
// `expected` block is the rubric the harness grades against.
//
// Fixtures are authored from real pupil submissions (with IDs stripped)
// during the pilot-seeding pass. Synthetic seed fixtures ship in the
// repo so the harness has something to exercise on day one.

export const EXPECTED_RESPONSE_TYPES = [
  'medium_text',
  'extended_response',
  'code',
  'algorithm',
] as const;

export const EvalFixtureSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  part: z.object({
    id: z.string().min(1),
    marks: z.number().int().nonnegative(),
    expected_response_type: z.enum(EXPECTED_RESPONSE_TYPES),
    prompt: z.string().min(1),
    raw_answer: z.string(),
    part_label: z.string().min(1),
  }),
  markPoints: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        accepted_alternatives: z.array(z.string()),
        marks: z.number().int().positive(),
        is_required: z.boolean(),
      }),
    )
    .min(1),
  questionStem: z.string().min(1),
  modelAnswer: z.string().min(1),
  expected: z.object({
    marksAwardedRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    mustHitMarkPointIds: z.array(z.string()),
    mustNotHitMarkPointIds: z.array(z.string()),
    shouldRefuse: z.boolean(),
    maxAbsoluteError: z.number().int().nonnegative().optional(),
  }),
});

export type EvalFixture = z.infer<typeof EvalFixtureSchema>;

export interface LoadedFixture {
  readonly promptName: string;
  readonly filePath: string;
  readonly fixture: EvalFixture;
}

const PROMPT_NAMES_WITH_FIXTURES = ['mark_open_response', 'mark_code_response'] as const;

export async function loadFixturesFromDisk(rootDir: string): Promise<LoadedFixture[]> {
  const loaded: LoadedFixture[] = [];
  for (const promptName of PROMPT_NAMES_WITH_FIXTURES) {
    const dir = path.join(rootDir, promptName);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(dir, entry);
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = EvalFixtureSchema.parse(JSON.parse(raw));
      assertFixtureInternallyConsistent(parsed, filePath);
      loaded.push({ promptName, filePath, fixture: parsed });
    }
  }
  return loaded;
}

function assertFixtureInternallyConsistent(fx: EvalFixture, filePath: string): void {
  const ids = new Set(fx.markPoints.map((m) => m.id));
  for (const id of fx.expected.mustHitMarkPointIds) {
    if (!ids.has(id)) {
      throw new Error(`${filePath}: expected.mustHitMarkPointIds references unknown id ${id}`);
    }
  }
  for (const id of fx.expected.mustNotHitMarkPointIds) {
    if (!ids.has(id)) {
      throw new Error(`${filePath}: expected.mustNotHitMarkPointIds references unknown id ${id}`);
    }
  }
  const [lo, hi] = fx.expected.marksAwardedRange;
  if (lo > hi) {
    throw new Error(`${filePath}: marksAwardedRange ${lo}..${hi} is inverted`);
  }
  if (hi > fx.part.marks) {
    throw new Error(
      `${filePath}: marksAwardedRange upper ${hi} exceeds part.marks ${fx.part.marks}`,
    );
  }
}
