-- People, classes, enrolments, and server-side sessions. Phase 0.
-- Mirrors DATA_MODEL.md "People and groups".

CREATE TYPE user_role AS ENUM ('pupil', 'teacher', 'admin');

CREATE TABLE users (
  id                      BIGSERIAL PRIMARY KEY,
  role                    user_role   NOT NULL,
  display_name            TEXT        NOT NULL,
  username                CITEXT      NOT NULL UNIQUE,
  password_hash           TEXT        NOT NULL,
  must_change_password    BOOLEAN     NOT NULL DEFAULT true,
  failed_login_count      INT         NOT NULL DEFAULT 0,
  locked_until            TIMESTAMPTZ NULL,
  last_login_at           TIMESTAMPTZ NULL,
  active                  BOOLEAN     NOT NULL DEFAULT true,
  pseudonym               TEXT        NOT NULL UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_role_idx ON users (role);

CREATE TABLE classes (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT        NOT NULL,
  teacher_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  academic_year  TEXT        NOT NULL,
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, academic_year, name)
);

CREATE TABLE enrolments (
  class_id    BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  user_id     BIGINT NOT NULL REFERENCES users (id)   ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);

CREATE INDEX enrolments_user_idx ON enrolments (user_id);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  user_agent    TEXT        NOT NULL,
  ip_hash       TEXT        NOT NULL
);

CREATE INDEX sessions_user_idx     ON sessions (user_id);
CREATE INDEX sessions_expires_idx  ON sessions (expires_at);
