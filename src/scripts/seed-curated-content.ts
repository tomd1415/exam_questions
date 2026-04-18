/**
 * Seed curated OCR J277 questions from content/curated/*.json.
 *
 *   npm run content:seed                 -- defaults to ./content/curated
 *   npm run content:seed -- --dir path/  -- custom folder
 *   npm run content:seed -- --dry-run    -- validate only, no writes
 *
 * Idempotent: each JSON file carries a stable `external_key`; the seeder
 * stores `curated:<external_key>` in `questions.similarity_hash` and
 * updates the existing row on subsequent runs. Curated questions are
 * marked `approved + active` so the pupil flow can pick them up
 * straight away.
 */
import { readFile, readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/pool.js';
import { CurriculumRepo } from '../repos/curriculum.js';
import { QuestionRepo } from '../repos/questions.js';
import {
  CuratedQuestionJson,
  externalKeyToSimilarityHash,
  toQuestionDraft,
  type CuratedQuestion,
} from '../lib/content-schema.js';
import {
  validateQuestionDraft,
  type QuestionDraftReferenceData,
} from '../lib/question-invariants.js';
import { validatePartConfig } from '../lib/widgets.js';
import { hashPassword } from '../lib/passwords.js';
import { randomBytes } from 'node:crypto';

interface LoadResult {
  file: string;
  json: unknown;
  parsed?: CuratedQuestion;
  error?: string;
}

interface RunSummary {
  scanned: number;
  created: number;
  updated: number;
  failed: number;
  errors: { file: string; message: string }[];
}

export interface SeedOptions {
  dir: string;
  dryRun: boolean;
  authorUsername: string;
}

async function loadContentFiles(dir: string): Promise<LoadResult[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: LoadResult[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const file = path.join(dir, ent.name);
    try {
      const raw = await readFile(file, 'utf8');
      const json: unknown = JSON.parse(raw);
      out.push({ file, json });
    } catch (err) {
      out.push({
        file,
        json: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

async function ensureSeedUser(pool: Pool, username: string): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM users WHERE username = $1 AND role IN ('teacher','admin') LIMIT 1`,
    [username],
  );
  if (existing.rows.length > 0) return existing.rows[0]!.id;

  const password = randomBytes(32).toString('hex');
  const passwordHash = await hashPassword(password);
  const pseudonym = 'CUR-SEED-00';
  const displayName = 'Curated content seeder';

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password, pseudonym, active)
     VALUES ('teacher', $1, $2, $3, false, $4, true)
     ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id::text`,
    [displayName, username, passwordHash, pseudonym],
  );
  return rows[0]!.id;
}

export async function seedCuratedContent(
  opts: SeedOptions,
  pool: Pool = defaultPool,
): Promise<RunSummary> {
  const summary: RunSummary = {
    scanned: 0,
    created: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  const files = await loadContentFiles(opts.dir);
  summary.scanned = files.length;

  const parsed: { file: string; question: CuratedQuestion }[] = [];
  for (const entry of files) {
    if (entry.error) {
      summary.failed++;
      summary.errors.push({ file: entry.file, message: `JSON parse: ${entry.error}` });
      continue;
    }
    const result = CuratedQuestionJson.safeParse(entry.json);
    if (!result.success) {
      summary.failed++;
      const msg = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      summary.errors.push({ file: entry.file, message: `schema: ${msg}` });
      continue;
    }
    parsed.push({ file: entry.file, question: result.data });
  }

  const keys = new Set<string>();
  for (const { file, question } of parsed) {
    if (keys.has(question.external_key)) {
      summary.failed++;
      summary.errors.push({
        file,
        message: `duplicate external_key '${question.external_key}' in another file this run`,
      });
    } else {
      keys.add(question.external_key);
    }
  }

  const curriculumRepo = new CurriculumRepo(pool);
  const questionRepo = new QuestionRepo(pool);
  const refs: QuestionDraftReferenceData = await curriculumRepo.getReferenceData();

  const authorId = opts.dryRun ? '0' : await ensureSeedUser(pool, opts.authorUsername);

  for (const { file, question } of parsed) {
    try {
      const draft = toQuestionDraft(question);
      const validation = validateQuestionDraft(draft, refs);
      if (!validation.ok) {
        summary.failed++;
        const msg = validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        summary.errors.push({ file, message: `invariants: ${msg}` });
        continue;
      }

      const configIssues: string[] = [];
      validation.value.parts.forEach((p, idx) => {
        for (const issue of validatePartConfig(p.expected_response_type, p.part_config)) {
          configIssues.push(`parts.${String(idx)}.part_config: ${issue.message}`);
        }
      });
      if (configIssues.length > 0) {
        summary.failed++;
        summary.errors.push({ file, message: `widget config: ${configIssues.join('; ')}` });
        continue;
      }

      const hash = externalKeyToSimilarityHash(question.external_key);
      const existingId = await questionRepo.findIdBySimilarityHash(hash);

      if (opts.dryRun) {
        if (existingId) summary.updated++;
        else summary.created++;
        continue;
      }

      if (existingId) {
        await questionRepo.updateWithChildren(existingId, {
          ...validation.value,
          created_by: authorId,
        });
        await questionRepo.setApprovalStatus(existingId, {
          approval_status: 'approved',
          approved_by: authorId,
          active: true,
          review_notes: null,
        });
        summary.updated++;
      } else {
        const newId = await questionRepo.createWithChildren({
          ...validation.value,
          created_by: authorId,
        });
        await questionRepo.setSimilarityHash(newId, hash);
        await questionRepo.setApprovalStatus(newId, {
          approval_status: 'approved',
          approved_by: authorId,
          active: true,
          review_notes: null,
        });
        summary.created++;
      }
    } catch (err) {
      summary.failed++;
      summary.errors.push({
        file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function printSummary(summary: RunSummary): void {
  console.log(
    `Seed summary: scanned=${summary.scanned} created=${summary.created} updated=${summary.updated} failed=${summary.failed}`,
  );
  if (summary.errors.length > 0) {
    console.error('Errors:');
    for (const e of summary.errors) {
      console.error(`  ${path.basename(e.file)}: ${e.message}`);
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'author-username': { type: 'string' },
    },
  });

  const opts: SeedOptions = {
    dir: path.resolve(values.dir ?? './content/curated'),
    dryRun: values['dry-run'] ?? false,
    authorUsername: values['author-username'] ?? 'curated_seed',
  };

  const summary = await seedCuratedContent(opts);
  printSummary(summary);
  await defaultPool.end();
  process.exit(summary.failed > 0 ? 1 : 0);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await defaultPool.end();
    process.exit(1);
  });
}
