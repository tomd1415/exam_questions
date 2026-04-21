import type { Pool } from 'pg';

// Admin-managed content-guard patterns. See migration 0031 and
// PHASE3_PLAN.md §5 chunk 3d. Two kinds of patterns live here:
// safeguarding strings the safety gate treats as an immediate
// flag-to-moderation signal, and prompt-injection strings that
// indicate a pupil is trying to talk the LLM into awarding marks it
// should not. Both are case-insensitive substring matches at read
// time (see src/lib/content-guards.ts for the matcher).
//
// The seeded baseline in src/lib/content-guards.ts is always active
// and not represented as DB rows. The DB rows are the admin's
// extension points — patterns they notice in the wild.

export type ContentGuardKind = 'safeguarding' | 'prompt_injection';

export const CONTENT_GUARD_KINDS: readonly ContentGuardKind[] = [
  'safeguarding',
  'prompt_injection',
] as const;

export interface ContentGuardPatternRow {
  id: string;
  kind: ContentGuardKind;
  pattern: string;
  note: string | null;
  created_by: string | null;
  created_at: Date;
  active: boolean;
}

export interface ContentGuardPatternInsert {
  kind: ContentGuardKind;
  pattern: string;
  note: string | null;
  createdBy: string | null;
}

const SELECT_COLUMNS = `
  id::text,
  kind,
  pattern,
  note,
  created_by::text AS created_by,
  created_at,
  active
`;

export class ContentGuardRepo {
  constructor(private readonly db: Pool) {}

  async listAll(): Promise<ContentGuardPatternRow[]> {
    const { rows } = await this.db.query<ContentGuardPatternRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM content_guard_patterns
        ORDER BY kind ASC, created_at DESC, id DESC`,
    );
    return rows;
  }

  async listActive(): Promise<ContentGuardPatternRow[]> {
    const { rows } = await this.db.query<ContentGuardPatternRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM content_guard_patterns
        WHERE active = true
        ORDER BY kind ASC, created_at DESC, id DESC`,
    );
    return rows;
  }

  async insert(input: ContentGuardPatternInsert): Promise<ContentGuardPatternRow> {
    const { rows } = await this.db.query<ContentGuardPatternRow>(
      `INSERT INTO content_guard_patterns (kind, pattern, note, created_by)
       VALUES ($1, $2, $3, $4::bigint)
       RETURNING ${SELECT_COLUMNS}`,
      [input.kind, input.pattern, input.note, input.createdBy],
    );
    return rows[0]!;
  }

  async setActive(id: string, active: boolean): Promise<ContentGuardPatternRow | null> {
    const { rows } = await this.db.query<ContentGuardPatternRow>(
      `UPDATE content_guard_patterns
          SET active = $2
        WHERE id = $1::bigint
        RETURNING ${SELECT_COLUMNS}`,
      [id, active],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<ContentGuardPatternRow | null> {
    const { rows } = await this.db.query<ContentGuardPatternRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM content_guard_patterns
        WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ?? null;
  }
}
