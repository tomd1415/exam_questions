#!/usr/bin/env bash
# Daily DB backup. Writes a custom-format pg_dump and a sha256 checksum to
# $BACKUP_DIR. Intended to be run from cron / a systemd timer on the prod VM,
# and also runnable locally against the dev Postgres for testing.
#
# Required env:
#   PGHOST, PGPORT, PGUSER, PGDATABASE  (or PGURL)
#   PGPASSWORD (or use ~/.pgpass)
# Optional env:
#   BACKUP_DIR  default: /var/backups/exam-questions
#   RETAIN_DAYS default: 14   (0 disables pruning)
#   PG_DUMP     default: pg_dump
#                Override when the host pg_dump version differs from the
#                server (e.g. dev: `PG_DUMP="docker compose exec -T postgres pg_dump"`).
#
# Usage:
#   PGHOST=localhost PGPORT=5433 PGUSER=exam PGDATABASE=exam_dev \
#     PGPASSWORD=exam BACKUP_DIR=/tmp/exam-backups ./scripts/backup-db.sh

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/exam-questions}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DB="${PGDATABASE:-exam_dev}"

mkdir -p "$BACKUP_DIR"

DUMP="$BACKUP_DIR/${DB}-${TS}.dump"
SHA="$BACKUP_DIR/${DB}-${TS}.sha256"

echo "[backup-db] dumping ${DB} → ${DUMP}"
# shellcheck disable=SC2086 # PG_DUMP may legitimately be a multi-word command.
${PG_DUMP:-pg_dump} --format=custom --no-owner --no-privileges "${DB}" > "$DUMP"

echo "[backup-db] computing sha256 → ${SHA}"
sha256sum "$DUMP" | awk '{print $1}' > "$SHA"

if [[ "$RETAIN_DAYS" -gt 0 ]]; then
  echo "[backup-db] pruning dumps older than ${RETAIN_DAYS}d in ${BACKUP_DIR}"
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "${DB}-*.dump" -o -name "${DB}-*.sha256" \) \
    -mtime +"$RETAIN_DAYS" -print -delete
fi

SIZE=$(stat -c %s "$DUMP")
echo "[backup-db] OK ${DUMP} (${SIZE} bytes)"
