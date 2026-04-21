import type { Pool } from 'pg';

// Append-only cost/outcome log for every outbound LLM call. See
// migration 0029_llm_calls.sql and PHASE3_PLAN.md §5 chunk 3b. The
// client in src/services/llm/client.ts writes exactly one row per
// call attempt — on success, schema failure, refusal, HTTP error,
// and timeout. That invariant is what makes the cost dashboard
// (chunk 3g) trustworthy.

export type LlmCallStatus = 'ok' | 'refusal' | 'schema_invalid' | 'http_error' | 'timeout';

export const LLM_CALL_STATUSES: readonly LlmCallStatus[] = [
  'ok',
  'refusal',
  'schema_invalid',
  'http_error',
  'timeout',
] as const;

export interface LlmCallRow {
  id: string;
  prompt_version_id: string;
  attempt_part_id: string | null;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_pence: number;
  latency_ms: number;
  status: LlmCallStatus;
  error_message: string | null;
  created_at: Date;
}

export interface LlmCallInsert {
  promptVersionId: string;
  attemptPartId: string | null;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  latencyMs: number;
  status: LlmCallStatus;
  errorMessage: string | null;
}

const SELECT_COLUMNS = `
  id::text,
  prompt_version_id::text,
  attempt_part_id::text,
  model_id,
  input_tokens,
  output_tokens,
  cost_pence,
  latency_ms,
  status,
  error_message,
  created_at
`;

export class LlmCallRepo {
  constructor(private readonly db: Pool) {}

  async insert(input: LlmCallInsert): Promise<LlmCallRow> {
    const { rows } = await this.db.query<LlmCallRow>(
      `INSERT INTO llm_calls
         (prompt_version_id, attempt_part_id, model_id, input_tokens, output_tokens,
          cost_pence, latency_ms, status, error_message)
       VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.promptVersionId,
        input.attemptPartId,
        input.modelId,
        input.inputTokens,
        input.outputTokens,
        input.costPence,
        input.latencyMs,
        input.status,
        input.errorMessage,
      ],
    );
    return rows[0]!;
  }

  async listRecent(limit = 100): Promise<LlmCallRow[]> {
    const { rows } = await this.db.query<LlmCallRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM llm_calls
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  // Chunk 3g rollups. Cost dashboard reads these directly — each row
  // is one (prompt_version, model) pairing with totals for the window.
  // Cost is in pence at integer precision (see migration 0029). The
  // `ok_calls` count is split out so the dashboard can show how many
  // calls actually produced a mark vs how many burned budget on
  // refusals / schema errors / timeouts.
  async rollupBetween(start: Date, end: Date): Promise<LlmCostRollupRow[]> {
    const { rows } = await this.db.query<LlmCostRollupRow>(
      `SELECT c.prompt_version_id::text AS prompt_version_id,
              pv.name                    AS prompt_name,
              pv.version                 AS prompt_version,
              c.model_id                 AS model_id,
              COUNT(*)::int              AS calls,
              SUM((c.status = 'ok')::int)::int AS ok_calls,
              COALESCE(SUM(c.input_tokens), 0)::int  AS input_tokens,
              COALESCE(SUM(c.output_tokens), 0)::int AS output_tokens,
              COALESCE(SUM(c.cost_pence), 0)::int    AS cost_pence
         FROM llm_calls c
         JOIN prompt_versions pv ON pv.id = c.prompt_version_id
        WHERE c.created_at >= $1
          AND c.created_at < $2
        GROUP BY c.prompt_version_id, pv.name, pv.version, c.model_id
        ORDER BY cost_pence DESC, prompt_name ASC, prompt_version ASC`,
      [start, end],
    );
    return rows;
  }
}

export interface LlmCostRollupRow {
  prompt_version_id: string;
  prompt_name: string;
  prompt_version: string;
  model_id: string;
  calls: number;
  ok_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_pence: number;
}
