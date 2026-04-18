// Backfill helper for migration 0019_trace_table_grid.
//
// Phase 2 stored nothing structured in question_parts.part_config for
// trace_table parts (the legacy widget was a free-text textarea), so
// the backfill's job is conservative:
//
//   * find every question_part where expected_response_type='trace_table'
//     and part_config IS NULL OR is missing the new shape's required keys;
//   * set part_config to a minimal "teacher-marked" placeholder grid
//     sized from part.marks (one row per mark, two columns: "step" and
//     "value") with empty `expected` and `marking.mode='perCell'`.
//
// Empty `expected` means the deterministic marker awards 0 marks but
// does not crash; the part is still mark-able by a teacher via the
// existing teacher_review pipeline once they author real expected
// values. This buys time to migrate questions one at a time without
// losing any pupil work in flight.
//
// Idempotent: rows whose part_config already has all four required
// keys (`columns`, `rows`, `expected`, `marking`) are skipped, so the
// script is safe to re-run.
//
// Run with `npx tsx scripts/migrate/0019-trace-table-backfill.ts`.
// Pass `--dry-run` to preview the row count without writing.

import { pool } from '../../src/db/pool.js';

interface RowState {
  id: number;
  marks: number;
  part_config: unknown;
}

function hasNewShape(cfg: unknown): boolean {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  const o = cfg as Record<string, unknown>;
  return 'columns' in o && 'rows' in o && 'expected' in o && 'marking' in o;
}

function placeholderConfig(marks: number): Record<string, unknown> {
  const rows = Math.max(2, marks);
  return {
    columns: [{ name: 'step' }, { name: 'value' }],
    rows,
    expected: {},
    marking: { mode: 'perCell' },
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { rows } = await pool.query<RowState>(
    `SELECT id, marks, part_config
       FROM question_parts
      WHERE expected_response_type = 'trace_table'`,
  );

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (hasNewShape(row.part_config)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      migrated += 1;
      continue;
    }
    await pool.query(
      `UPDATE question_parts
          SET part_config = $1::jsonb
        WHERE id = $2`,
      [JSON.stringify(placeholderConfig(row.marks)), row.id],
    );
    migrated += 1;
  }

  console.log(
    `[0019-trace-table-backfill] ${dryRun ? 'DRY RUN — would migrate' : 'migrated'} ` +
      `${migrated} row(s); skipped ${skipped} already-shaped row(s).`,
  );

  await pool.end();
}

main().catch((err: unknown) => {
  console.error('[0019-trace-table-backfill] failed:', err);
  process.exitCode = 1;
});
