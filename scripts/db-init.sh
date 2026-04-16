#!/usr/bin/env bash
# Runs once, the first time the Postgres container initialises its data volume.
# Use `npm run db:reset` to re-trigger by wiping the volume.

set -euo pipefail

psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-'SQL'
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS citext;
SQL
