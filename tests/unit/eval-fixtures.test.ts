import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalFixtureSchema, loadFixturesFromDisk } from '../../src/services/eval/fixtures.js';

// Chunk 3h. Loader integrity. The harness loads fixtures as JSON from
// disk; these tests pin the validation invariants so a malformed
// fixture can't sneak past CI and break a nightly run with a confusing
// Zod stack.

const GOOD_FIXTURE = {
  id: 'open_001',
  description: 'full marks',
  part: {
    id: 'part-1',
    marks: 2,
    expected_response_type: 'medium_text',
    prompt: 'Describe RAM.',
    raw_answer: 'RAM is volatile.',
    part_label: '1a',
  },
  markPoints: [
    {
      id: 'mp_1',
      text: 'Volatile',
      accepted_alternatives: [],
      marks: 1,
      is_required: false,
    },
    {
      id: 'mp_2',
      text: 'In-use data',
      accepted_alternatives: [],
      marks: 1,
      is_required: false,
    },
  ],
  questionStem: 'stem',
  modelAnswer: 'answer',
  expected: {
    marksAwardedRange: [2, 2],
    mustHitMarkPointIds: ['mp_1'],
    mustNotHitMarkPointIds: [],
    shouldRefuse: false,
  },
};

describe('EvalFixtureSchema', () => {
  it('accepts a well-formed fixture', () => {
    expect(() => EvalFixtureSchema.parse(GOOD_FIXTURE)).not.toThrow();
  });

  it('rejects an unknown expected_response_type', () => {
    const bad = {
      ...GOOD_FIXTURE,
      part: { ...GOOD_FIXTURE.part, expected_response_type: 'nonsense' },
    };
    expect(() => EvalFixtureSchema.parse(bad)).toThrow();
  });

  it('rejects an empty markPoints array', () => {
    const bad = { ...GOOD_FIXTURE, markPoints: [] };
    expect(() => EvalFixtureSchema.parse(bad)).toThrow();
  });
});

describe('loadFixturesFromDisk', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'eval-fx-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads .json files from each prompt directory, sorted by filename', async () => {
    const openDir = path.join(root, 'mark_open_response');
    const codeDir = path.join(root, 'mark_code_response');
    mkdirSync(openDir, { recursive: true });
    mkdirSync(codeDir, { recursive: true });

    writeFileSync(
      path.join(openDir, '002.json'),
      JSON.stringify({ ...GOOD_FIXTURE, id: 'open_002' }),
    );
    writeFileSync(
      path.join(openDir, '001.json'),
      JSON.stringify({ ...GOOD_FIXTURE, id: 'open_001' }),
    );
    writeFileSync(
      path.join(codeDir, '001.json'),
      JSON.stringify({
        ...GOOD_FIXTURE,
        id: 'code_001',
        part: { ...GOOD_FIXTURE.part, expected_response_type: 'code' },
      }),
    );
    // Non-json files are ignored.
    writeFileSync(path.join(openDir, 'README.md'), '# skip me');

    const loaded = await loadFixturesFromDisk(root);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((l) => `${l.promptName}/${l.fixture.id}`)).toEqual([
      'mark_open_response/open_001',
      'mark_open_response/open_002',
      'mark_code_response/code_001',
    ]);
  });

  it('returns an empty list when the fixtures root is absent', async () => {
    const loaded = await loadFixturesFromDisk(path.join(root, 'does-not-exist'));
    expect(loaded).toEqual([]);
  });

  it('throws when a fixture references a mark-point id that does not exist', async () => {
    const openDir = path.join(root, 'mark_open_response');
    mkdirSync(openDir, { recursive: true });
    writeFileSync(
      path.join(openDir, 'bad.json'),
      JSON.stringify({
        ...GOOD_FIXTURE,
        expected: {
          ...GOOD_FIXTURE.expected,
          mustHitMarkPointIds: ['mp_does_not_exist'],
        },
      }),
    );
    await expect(loadFixturesFromDisk(root)).rejects.toThrow(/mp_does_not_exist/);
  });

  it('throws when marksAwardedRange is inverted', async () => {
    const openDir = path.join(root, 'mark_open_response');
    mkdirSync(openDir, { recursive: true });
    writeFileSync(
      path.join(openDir, 'bad.json'),
      JSON.stringify({
        ...GOOD_FIXTURE,
        expected: { ...GOOD_FIXTURE.expected, marksAwardedRange: [2, 1] },
      }),
    );
    await expect(loadFixturesFromDisk(root)).rejects.toThrow(/inverted/);
  });

  it('throws when the expected upper exceeds part.marks', async () => {
    const openDir = path.join(root, 'mark_open_response');
    mkdirSync(openDir, { recursive: true });
    writeFileSync(
      path.join(openDir, 'bad.json'),
      JSON.stringify({
        ...GOOD_FIXTURE,
        expected: { ...GOOD_FIXTURE.expected, marksAwardedRange: [2, 5] },
      }),
    );
    await expect(loadFixturesFromDisk(root)).rejects.toThrow(/exceeds part\.marks/);
  });
});

describe('seed fixtures that ship with the repo', () => {
  it('all validate and stay internally consistent', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const loaded = await loadFixturesFromDisk(path.join(repoRoot, 'prompts', 'eval'));
    expect(loaded.length).toBeGreaterThanOrEqual(5);
    const ids = loaded.map((l) => l.fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of loaded) {
      if (entry.promptName === 'mark_open_response') {
        expect(['medium_text', 'extended_response']).toContain(
          entry.fixture.part.expected_response_type,
        );
      }
      if (entry.promptName === 'mark_code_response') {
        expect(['code', 'algorithm']).toContain(entry.fixture.part.expected_response_type);
      }
    }
  });
});
