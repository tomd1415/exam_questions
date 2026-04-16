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

// One teardown per test file. Tests that allocate isolated pools should
// end them themselves; this catches the shared pool plus any stragglers.
afterAll(async () => {
  await endAllPools();
});
