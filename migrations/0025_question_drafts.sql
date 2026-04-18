-- Phase 2.5 chunk 2.5j step 1 — question authoring wizard drafts.
--
-- Each row is one in-progress wizard session. The teacher accumulates
-- their answers across nine steps in `payload` (a JSONB document whose
-- shape is the wizard-payload type in src/repos/question_drafts.ts);
-- `current_step` is the highest step the author has reached so resuming
-- on another device lands them where they left off, not at step 1.
--
-- `published_question_id` is set exactly once, when the wizard's
-- "Publish" action on step 9 hands the payload to QuestionService and
-- inserts the live `questions` / `question_parts` / `mark_points` /
-- `common_misconceptions` rows. Once set, the draft is locked from
-- further `advance` calls — re-edit goes through the existing
-- /admin/questions UI on the published question, not the wizard.
--
-- Drafts are author-private: only the row's `author_user_id` (and
-- admins) can read or advance it. The unique index on
-- (author_user_id, created_at) underpins the "My drafts" list query.

CREATE TABLE question_drafts (
  id                    BIGSERIAL   PRIMARY KEY,
  author_user_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  current_step          SMALLINT    NOT NULL DEFAULT 1
    CHECK (current_step BETWEEN 1 AND 9),
  payload               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  published_question_id BIGINT      NULL REFERENCES questions (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX question_drafts_author_created_idx
  ON question_drafts (author_user_id, created_at DESC);

CREATE INDEX question_drafts_published_idx
  ON question_drafts (published_question_id)
  WHERE published_question_id IS NOT NULL;
