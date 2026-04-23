// Per-fork setup: runs BEFORE any test file is imported, so env mutations
// here are seen by src/config.ts when tests trigger it transitively.

import { afterAll } from 'vitest';
import { endAllPools } from './helpers/db.js';

const testUrl = process.env['TEST_DATABASE_URL'];
if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set — tests/global-setup.ts must run before this file.',
  );
}
process.env['DATABASE_URL'] = testUrl;

// Provide deterministic values for the rest of config.ts so its zod schema
// validates whether or not a .env exists (e.g. on CI). Existing values win
// because dotenv does not override and we use `??`.
process.env['SESSION_SECRET'] ??=
  'test-session-secret-test-session-secret-test-session-secret-0123';
process.env['ADMIN_INITIAL_PASSWORD'] ??= 'test-admin-password';
process.env['NODE_ENV'] ??= 'test';
process.env['LOG_LEVEL'] ??= 'silent';

// Tests MUST NOT hit the real OpenAI endpoint. A developer `.env` with
// LLM_ENABLED=true + OPENAI_API_KEY would otherwise be picked up by
// src/config.ts on every app-boot test, producing real network calls
// with multi-second latency and real cost. Tests that need LLM
// behaviour build their own LlmClient with a stubbed fetch (see
// tests/integration/moderation-queue.test.ts). Force-override rather
// than `??=` so a stray env value cannot leak in.
process.env['LLM_ENABLED'] = 'false';
delete process.env['OPENAI_API_KEY'];

// One teardown per test file. Tests that allocate isolated pools should
// end them themselves; this catches the shared pool plus any stragglers.
afterAll(async () => {
  await endAllPools();
});
