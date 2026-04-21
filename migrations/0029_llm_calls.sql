-- Chunk 3b. Append-only audit log of every outbound LLM call. Each
-- row records what we sent (prompt_version_id + model_id), what it
-- cost (tokens, pence, latency), and what happened (status). Pence
-- are integers so the cost dashboard in 3g can SUM() without any
-- floating-point footguns. `cost_pence = 0` is a legitimate value
-- for refusals or schema failures where we were still billed at
-- zero tokens, or for HTTP errors where the call never completed.
--
-- `attempt_part_id` is nullable because some calls (evals, pre-flight
-- checks) are not tied to a real attempt. ON DELETE SET NULL so that
-- rotating out an attempt never silently deletes a cost row — the
-- accounting trail stays intact even if the attempt goes.
--
-- No foreign key to awarded_marks: a single call may produce zero,
-- one, or several mark rows depending on safety gate / moderation
-- outcome. The join goes the other way — awarded_marks already
-- carries prompt_version + model_id strings for retrieval.

CREATE TABLE llm_calls (
  id                BIGSERIAL   PRIMARY KEY,
  prompt_version_id BIGINT      NOT NULL REFERENCES prompt_versions (id),
  attempt_part_id   BIGINT      NULL REFERENCES attempt_parts (id) ON DELETE SET NULL,
  model_id          TEXT        NOT NULL,
  input_tokens      INT         NOT NULL,
  output_tokens     INT         NOT NULL,
  cost_pence        INT         NOT NULL,
  latency_ms        INT         NOT NULL,
  status            TEXT        NOT NULL
                      CHECK (status IN ('ok', 'refusal', 'schema_invalid', 'http_error', 'timeout')),
  error_message     TEXT        NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX llm_calls_recent_idx ON llm_calls (created_at DESC);
