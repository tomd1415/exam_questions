/**
 * Nightly prompt eval harness (Chunk 3h).
 *
 *   npm run eval             # uses the active prompts in the DB and real OpenAI
 *   EVAL_DRY_RUN=1 npm run eval   # loads fixtures and reports without calling the API
 *
 * Exit code is non-zero when any fixture fails, so CI can gate prompt
 * promotions on a green run. Reports are written to
 * scripts/eval/out/{timestamp}.{json,md}; the admin page at
 * /admin/evals/latest reads the most recent JSON.
 *
 * This script is a thin wrapper — the actual scoring lives in
 * src/services/eval/*. Everything IO-shaped (DB pool, OpenAI key,
 * filesystem) is handled here; pure logic is imported.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import { LlmCallRepo } from '../../src/repos/llm_calls.js';
import { PromptVersionRepo } from '../../src/repos/prompts.js';
import { LlmClient } from '../../src/services/llm/client.js';
import { LlmOpenResponseMarker } from '../../src/services/marking/llm.js';
import { PromptVersionService } from '../../src/services/prompts.js';
import { loadFixturesFromDisk } from '../../src/services/eval/fixtures.js';
import { runEvals, type EvalMarker } from '../../src/services/eval/runner.js';
import { writeReport } from '../../src/services/eval/report.js';

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRNAME, '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'prompts', 'eval');
const OUT_DIR = path.join(ROOT, 'scripts', 'eval', 'out');

async function main(): Promise<void> {
  const fixtures = await loadFixturesFromDisk(FIXTURES_DIR);
  console.log(`Loaded ${fixtures.length} fixtures from ${FIXTURES_DIR}`);

  const promptRepo = new PromptVersionRepo(pool);
  const promptService = new PromptVersionService(promptRepo);
  await promptService.loadActive();
  const activeNames = new Set(promptService.listActive().map((p) => p.name));
  console.log(`Active prompts: ${[...activeNames].join(', ') || '(none)'}`);

  const marker = buildMarker(promptService);
  const { report } = await runEvals(fixtures, marker, { activePromptNames: activeNames });

  const written = await writeReport(OUT_DIR, report);
  console.log(`Wrote ${written.jsonPath}`);
  console.log(`Wrote ${written.markdownPath}`);

  const { passed, fixtures: total, failed } = report.totals;
  console.log(`Result: ${passed}/${total} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function buildMarker(promptService: PromptVersionService): EvalMarker {
  if (process.env['EVAL_DRY_RUN'] === '1') {
    return {
      mark: () => Promise.resolve({ kind: 'skipped', reason: 'no_active_prompt' }),
    };
  }
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for the eval harness (set EVAL_DRY_RUN=1 to skip)');
  }
  const llmCallRepo = new LlmCallRepo(pool);
  const client = new LlmClient(llmCallRepo, { apiKey: config.OPENAI_API_KEY });
  return new LlmOpenResponseMarker(client, promptService);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 2;
  })
  .finally(async () => {
    await pool.end();
  });
