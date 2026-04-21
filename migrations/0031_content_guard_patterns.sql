-- Chunk 3d. The safety gate runs two regex-based checks against the
-- pupil's raw answer: a safeguarding list (self-harm, abuse, crisis
-- signals) and a prompt-injection list (attempts to override the
-- marker's instructions). Both start as hard-coded seed patterns in
-- src/lib/content-guards.ts, but admins need to extend them in
-- production without a code change — e.g. a new jailbreak phrase
-- spotted in the wild, or a safeguarding keyword specific to the
-- school's context.
--
-- Scope is global/admin-only by design (single-school deployment,
-- sole admin). A future per-class override layer can be added on top
-- without reshaping this table.
--
-- Patterns are plain text treated as case-insensitive substring
-- matches at read time — we do not compile them as regex yet so that
-- an admin cannot accidentally DoS the marker with a catastrophic
-- backtracking pattern. If regex support is needed later, add a
-- `kind_mode` column rather than reinterpreting existing rows.
--
-- The `active` flag plus partial index let us soft-delete a pattern
-- (audit trail preserved) while keeping the cache query on the
-- hot path fast.

CREATE TABLE content_guard_patterns (
  id          BIGSERIAL   PRIMARY KEY,
  kind        TEXT        NOT NULL
                CHECK (kind IN ('safeguarding', 'prompt_injection')),
  pattern     TEXT        NOT NULL,
  note        TEXT        NULL,
  created_by  BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  active      BOOLEAN     NOT NULL DEFAULT true
);

CREATE INDEX content_guard_patterns_active_kind_idx
  ON content_guard_patterns (kind)
  WHERE active = true;
