-- Chunk 3a. LLM prompt versions live in the DB so every awarded_marks
-- row can cite the exact prompt body + output schema it was marked
-- against (awarded_marks.prompt_version + model_id were added in 0005
-- but until now had no table to reference). Prompt bodies themselves
-- live as markdown files under prompts/<name>/<version>.md — the DB
-- stores the compiled reference: name, semver, model id, the system
-- prompt text (snapshot at promotion time so a disk edit cannot
-- retroactively rewrite history), and the Structured Outputs JSON
-- schema.
--
-- One prompt name may have many versions; at most one is `active`.
-- The partial unique index enforces that. Promoting a new version is
-- a deploy-time action: a migration (or the seeder) marks the new
-- row `active` and retires the old one in the same transaction.
-- There is no UI for flipping the flag in Phase 3 — the admin page
-- added alongside this migration is read-only.

CREATE TABLE prompt_versions (
  id              BIGSERIAL   PRIMARY KEY,
  name            TEXT        NOT NULL,
  version         TEXT        NOT NULL,
  model_id        TEXT        NOT NULL,
  system_prompt   TEXT        NOT NULL,
  output_schema   JSONB       NOT NULL,
  status          TEXT        NOT NULL
                    CHECK (status IN ('draft', 'active', 'retired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE UNIQUE INDEX prompt_versions_one_active_per_name
  ON prompt_versions (name)
  WHERE status = 'active';

CREATE INDEX prompt_versions_name_created_idx
  ON prompt_versions (name, created_at DESC);
