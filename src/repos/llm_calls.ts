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
}
