-- Append-only audit log. Phase 0.
-- Mirrors DATA_MODEL.md "audit_events".

CREATE TABLE audit_events (
  id               BIGSERIAL PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id    BIGINT      NULL REFERENCES users (id) ON DELETE SET NULL,
  actor_role       TEXT        NOT NULL,
  subject_user_id  BIGINT      NULL REFERENCES users (id) ON DELETE SET NULL,
  event_type       TEXT        NOT NULL,
  details          JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_at_desc_idx
  ON audit_events (at DESC);

CREATE INDEX audit_events_actor_at_idx
  ON audit_events (actor_user_id, at DESC);

CREATE INDEX audit_events_event_type_idx
  ON audit_events (event_type);
