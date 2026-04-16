import { defineConfig } from 'vitest/config';

// All tests run in a single fork against a shared scratch DB created in
// tests/global-setup.ts. Serialising avoids cross-suite races on shared
// tables (sessions, audit_events, attempts, users). The suite is small
// enough that this is not a bottleneck.
export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/lib/**', 'src/services/**', 'src/repos/**', 'src/routes/**'],
      exclude: ['src/scripts/**', 'src/index.ts', 'src/db/migrate.ts'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
