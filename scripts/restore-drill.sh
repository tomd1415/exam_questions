#!/usr/bin/env bash
# DB-level restore drill. Restores the most recent pg_dump in $BACKUP_DIR
# into a fresh scratch database, runs verification queries, and drops it.
# Required to PASS at least once before Phase 0 sign-off, then half-termly.
#
# Required env: PGHOST, PGPORT, PGUSER, PGPASSWORD (or ~/.pgpass).
# Optional env:
#   PGDATABASE   default: exam_dev   (used to derive backup filename pattern)
#   BACKUP_DIR   default: /var/backups/exam-questions
#   DUMP         path to a specific dump (overrides "most recent")
#   PG_RESTORE   default: pg_restore (override for version-matched container, see backup-db.sh)
#   PSQL         default: psql       (override likewise)
#
# Exits non-zero on any verification failure. Always tries to drop the
# scratch DB even on failure.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/exam-questions}"
DB="${PGDATABASE:-exam_dev}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SCRATCH="exam_restore_drill_${TS}"

if [[ -n "${DUMP:-}" ]]; then
  : # caller-supplied
elif [[ -d "$BACKUP_DIR" ]]; then
  DUMP=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB}-*.dump" \
           -printf '%T@ %p\n' | sort -nr | head -1 | awk '{print $2}')
fi

if [[ -z "${DUMP:-}" || ! -f "$DUMP" ]]; then
  echo "[restore-drill] FAIL: no dump found (BACKUP_DIR=$BACKUP_DIR, DB=$DB)" >&2
  exit 2
fi

# Verify checksum if a sibling .sha256 exists.
SHA_FILE="${DUMP%.dump}.sha256"
if [[ -f "$SHA_FILE" ]]; then
  EXPECTED=$(awk '{print $1}' "$SHA_FILE")
  ACTUAL=$(sha256sum "$DUMP" | awk '{print $1}')
  if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "[restore-drill] FAIL: checksum mismatch on $DUMP" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  actual:   $ACTUAL"   >&2
    exit 3
  fi
  echo "[restore-drill] checksum OK"
else
  echo "[restore-drill] WARN: no checksum sibling for $DUMP — proceeding"
fi

cleanup() {
  local rc=$?
  echo "[restore-drill] dropping scratch DB ${SCRATCH}"
  ${PSQL:-psql} -d postgres -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS \"${SCRATCH}\";" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

echo "[restore-drill] creating scratch DB ${SCRATCH}"
${PSQL:-psql} -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${SCRATCH}\";" >/dev/null

echo "[restore-drill] restoring ${DUMP} → ${SCRATCH}"
# shellcheck disable=SC2086 # PG_RESTORE may legitimately be a multi-word command.
${PG_RESTORE:-pg_restore} --no-owner --no-privileges --dbname "${SCRATCH}" < "$DUMP"

echo "[restore-drill] verifying"
COUNTS=$(${PSQL:-psql} -d "${SCRATCH}" -At -v ON_ERROR_STOP=1 -c "
  SELECT
    (SELECT COUNT(*) FROM users)             || ' users, ' ||
    (SELECT COUNT(*) FROM questions)         || ' questions, ' ||
    (SELECT COUNT(*) FROM question_parts)    || ' parts, ' ||
    (SELECT COUNT(*) FROM audit_events)      || ' audit events, ' ||
    (SELECT COUNT(*) FROM schema_migrations) || ' migrations';
")

# Sanity: at least the curriculum seed must have landed.
LOOKUP=$(${PSQL:-psql} -d "${SCRATCH}" -At -v ON_ERROR_STOP=1 -c "
  SELECT (SELECT COUNT(*) FROM components)       || '/' ||
         (SELECT COUNT(*) FROM topics)           || '/' ||
         (SELECT COUNT(*) FROM subtopics)        || '/' ||
         (SELECT COUNT(*) FROM command_words);")
EXPECTED_LOOKUP="2/11/26/29"
if [[ "$LOOKUP" != "$EXPECTED_LOOKUP" ]]; then
  echo "[restore-drill] FAIL: curriculum seed mismatch (got ${LOOKUP}, expected ${EXPECTED_LOOKUP})" >&2
  exit 4
fi

echo "[restore-drill] PASS: ${COUNTS} (curriculum ${LOOKUP})"
