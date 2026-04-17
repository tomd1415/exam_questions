#!/usr/bin/env bash
# Run this ON the classroom test server, from the project root, after a fresh
# clone or `git pull`. It installs deps, builds, migrates, seeds curated
# content, sets up pupils/class/topic, and restarts the server.
#
# Idempotent: re-run whenever you pull a new commit.
#
# Usage (first deploy on a fresh box):
#   DATABASE_URL="postgres://exam:exam@localhost:5432/exam_prod" \
#   TEACHER_PASSWORD='<your-12+-char-password>' \
#   bash scripts/server-setup.sh
#
# Usage (redeploy an existing box — no DATABASE_URL needed, .env is kept):
#   bash scripts/server-setup.sh
#
# Environment:
#   DATABASE_URL           Required ONLY on first run (to mint .env).
#                          Subsequent runs read the existing .env.
#   PORT                   HTTP port (default 3030). Ignored if .env exists.
#   TEACHER_USERNAME       default 'tom'
#   TEACHER_PASSWORD       If set AND teacher missing, auto-creates them.
#                          Must be 12+ chars. Skip on re-runs.
#   TEACHER_DISPLAY_NAME   default 'Class Teacher'
#   TEACHER_PSEUDONYM      default 'TEA-0001'
#   LESSON_CLASS_NAME      default 'Phase 1 Lesson Test'
#   LESSON_TOPIC_CODE      default '2.1'
#   LESSON_PUPIL_COUNT     default 20
#   SKIP_SETUP_LESSON      set to 1 to skip the pupil/class setup step

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3030}"
ENV_FILE="${ROOT_DIR}/.env"

echo "───── Classroom server setup ─────"
echo "  project root : ${ROOT_DIR}"
echo "  http port    : ${PORT}"
echo ""

# ---------------------------------------------------------------------------
# 1. .env bootstrap. Only written if missing. Existing .env is never touched.
# ---------------------------------------------------------------------------
echo "── 1/5 .env bootstrap (only if missing)"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "  ✗ .env is missing and DATABASE_URL was not provided." >&2
    echo "    Re-run with: DATABASE_URL=... TEACHER_PASSWORD=... bash $0" >&2
    exit 64
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "  ✗ openssl is required to mint SESSION_SECRET but was not found." >&2
    exit 64
  fi
  SESSION_SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${PORT}
LOG_LEVEL=info
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
LLM_ENABLED=false
OPENAI_API_KEY=
OPENAI_MODEL_MARKING=
OPENAI_MODEL_GENERATION=
OPENAI_MODEL_EMBEDDING=text-embedding-3-small
ADMIN_USERNAME=admin
ADMIN_INITIAL_PASSWORD=change_me_on_first_login
EOF
  chmod 600 "$ENV_FILE"
  echo "  ✓ .env written with a fresh SESSION_SECRET"
else
  echo "  ✓ .env exists — leaving it alone"
fi

# ---------------------------------------------------------------------------
# 2. Install deps + build.
# ---------------------------------------------------------------------------
echo "── 2/5 npm ci + build"
npm ci
npm run build

# ---------------------------------------------------------------------------
# 3. Migrate + seed curated content.
# ---------------------------------------------------------------------------
echo "── 3/5 migrations + curated content seed"
npm run --silent db:migrate
# Seeder can FK-fail on re-runs when attempts exist; tolerate the benign case.
npm run --silent content:seed \
  || echo "  (seed reported non-zero — treat as benign if curated content is already present)"

# ---------------------------------------------------------------------------
# 4. Lesson setup (pupils, class, enrolments, topic).
# ---------------------------------------------------------------------------
if [[ "${SKIP_SETUP_LESSON:-0}" == "1" ]]; then
  echo "── 4/5 lesson setup: SKIPPED (SKIP_SETUP_LESSON=1)"
else
  echo "── 4/5 lesson setup (idempotent)"
  # Map unprefixed TEACHER_* → LESSON_TEACHER_* that setup-lesson.ts expects.
  export LESSON_TEACHER_USERNAME="${TEACHER_USERNAME:-${LESSON_TEACHER_USERNAME:-}}"
  export LESSON_TEACHER_PASSWORD="${TEACHER_PASSWORD:-${LESSON_TEACHER_PASSWORD:-}}"
  export LESSON_TEACHER_DISPLAY_NAME="${TEACHER_DISPLAY_NAME:-${LESSON_TEACHER_DISPLAY_NAME:-}}"
  export LESSON_TEACHER_PSEUDONYM="${TEACHER_PSEUDONYM:-${LESSON_TEACHER_PSEUDONYM:-}}"
  # Drop empty-string exports so defaults in setup-lesson.ts apply.
  for v in LESSON_TEACHER_USERNAME LESSON_TEACHER_PASSWORD \
           LESSON_TEACHER_DISPLAY_NAME LESSON_TEACHER_PSEUDONYM; do
    [[ -z "${!v}" ]] && unset "$v"
  done
  npm run --silent setup:lesson
fi

# ---------------------------------------------------------------------------
# 5. (Re)start server via nohup + pidfile.
# ---------------------------------------------------------------------------
echo "── 5/5 (re)start server"
PIDFILE="${ROOT_DIR}/tmp/server.pid"
LOGFILE="${ROOT_DIR}/tmp/server.log"
mkdir -p "${ROOT_DIR}/tmp"

if [[ -f "$PIDFILE" ]]; then
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "  stopping existing server (pid ${old_pid})"
    kill "$old_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

# Kill any stray listener on the port (prior aborted run).
if command -v ss >/dev/null 2>&1; then
  stray_pid="$(ss -lptn "sport = :${PORT}" 2>/dev/null \
    | awk -F 'pid=' '/pid=/{print $2}' | awk -F ',' '{print $1}' | head -n1)"
  if [[ -n "${stray_pid:-}" ]]; then
    echo "  killing stray listener on :${PORT} (pid ${stray_pid})"
    kill "$stray_pid" 2>/dev/null || true
  fi
fi

nohup npm run start > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
new_pid="$(cat "$PIDFILE")"
echo "  started server (pid ${new_pid}), log: ${LOGFILE}"

# Health check (poll up to ~20s).
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "  ✓ /healthz responded after ${i}s"
    echo ""
    echo "✓ Server ready."
    echo "  Sign in:   http://<server-address>:${PORT}/login"
    echo "  Logs:      ${LOGFILE}"
    echo "  Stop:      kill \$(cat ${PIDFILE})"
    exit 0
  fi
  sleep 1
done
echo "  ✗ server did not answer /healthz within 20s — see ${LOGFILE}" >&2
exit 1
