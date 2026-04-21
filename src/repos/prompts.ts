import type { Pool } from 'pg';

// LLM prompt versions. See migration 0028_prompt_versions.sql and
// PHASE3_PLAN.md §5 chunk 3a for the design rationale.
//
// `system_prompt` is snapshot at promotion time. The markdown file
// under prompts/<name>/<version>.md is the editable source; the DB
// row freezes the exact text that was promoted so a later edit to
// the file on disk cannot retroactively rewrite history for rows in
// awarded_marks that cite this prompt_version.
//
// `output_schema` is the Structured Outputs JSON schema the marker
// enforces. Stored as JSONB so the future validator (chunk 3b) can
// read it back without re-parsing markdown.

export type PromptVersionStatus = 'draft' | 'active' | 'retired';

export const PROMPT_VERSION_STATUSES: readonly PromptVersionStatus[] = [
  'draft',
  'active',
  'retired',
] as const;

export interface PromptVersionRow {
  id: string;
  name: string;
  version: string;
  model_id: string;
  system_prompt: string;
  output_schema: unknown;
  status: PromptVersionStatus;
  created_at: Date;
}

export interface PromptVersionInsert {
  name: string;
  version: string;
  modelId: string;
  systemPrompt: string;
  outputSchema: unknown;
  status: PromptVersionStatus;
}

const SELECT_COLUMNS = `
  id::text,
  name,
  version,
  model_id,
  system_prompt,
  output_schema,
  status,
  created_at
`;

export class PromptVersionRepo {
  constructor(private readonly db: Pool) {}

  async findActive(name: string): Promise<PromptVersionRow | null> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM prompt_versions
        WHERE name = $1 AND status = 'active'
        LIMIT 1`,
      [name],
    );
    return rows[0] ?? null;
  }

  async findByNameAndVersion(name: string, version: string): Promise<PromptVersionRow | null> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM prompt_versions
        WHERE name = $1 AND version = $2
        LIMIT 1`,
      [name, version],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<PromptVersionRow | null> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `SELECT ${SELECT_COLUMNS} FROM prompt_versions WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listAll(): Promise<PromptVersionRow[]> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM prompt_versions
        ORDER BY name ASC, created_at DESC, id DESC`,
    );
    return rows;
  }

  async listActive(): Promise<PromptVersionRow[]> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM prompt_versions
        WHERE status = 'active'
        ORDER BY name ASC`,
    );
    return rows;
  }

  async insert(input: PromptVersionInsert): Promise<PromptVersionRow> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `INSERT INTO prompt_versions
         (name, version, model_id, system_prompt, output_schema, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.name,
        input.version,
        input.modelId,
        input.systemPrompt,
        JSON.stringify(input.outputSchema),
        input.status,
      ],
    );
    return rows[0]!;
  }

  // Idempotent seeder upsert keyed on (name, version). The unique
  // constraint on (name, version) guarantees exactly one row per
  // pair; re-running the seed against an existing row refreshes the
  // prompt body/schema/model id and resets the status to match the
  // seed source of truth.
  async upsert(input: PromptVersionInsert): Promise<PromptVersionRow> {
    const { rows } = await this.db.query<PromptVersionRow>(
      `INSERT INTO prompt_versions
         (name, version, model_id, system_prompt, output_schema, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (name, version) DO UPDATE SET
         model_id = EXCLUDED.model_id,
         system_prompt = EXCLUDED.system_prompt,
         output_schema = EXCLUDED.output_schema,
         status = EXCLUDED.status
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.name,
        input.version,
        input.modelId,
        input.systemPrompt,
        JSON.stringify(input.outputSchema),
        input.status,
      ],
    );
    return rows[0]!;
  }
}
