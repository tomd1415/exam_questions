#!/usr/bin/env bash
# Deploy the current working copy to a Gentoo (or any Linux) test server
# over SSH for a classroom test run. Not a general-purpose deploy tool.
#
# Assumes the remote box has:
#   - bash, rsync, node >=22, npm
#   - Postgres reachable via $DEPLOY_DATABASE_URL (installed and running)
#   - SSH key auth for ${DEPLOY_USER}@${DEPLOY_HOST}
#
# Usage:
#   DEPLOY_HOST=classroom-test.lan \
#   DEPLOY_USER=tom \
#   DEPLOY_PATH=/srv/exam-questions \
#   DEPLOY_DATABASE_URL="postgres://exam:exam@localhost:5432/exam_prod" \
#   bash scripts/deploy-test-server.sh
#
# Optional:
#   DEPLOY_PORT                remote HTTP port (default 3030)
#   DEPLOY_SSH_PORT            SSH port (default 22)
#   SKIP_SETUP_LESSON          set to 1 to skip the pupil/class setup step
#   TEACHER_USERNAME           username for the lesson teacher (default 'tom')
#   TEACHER_PASSWORD           if set, auto-creates the teacher on first deploy
#                              (must be 12+ chars). Leave unset if you have already
#                              created the teacher on the remote.
#   TEACHER_DISPLAY_NAME       default 'Class Teacher'
#   TEACHER_PSEUDONYM          default 'TEA-0001'
#   LESSON_CLASS_NAME          default 'Phase 1 Lesson Test'
#   LESSON_TOPIC_CODE          default '2.1'
#   LESSON_PUPIL_COUNT         default 20
#
# The script is idempotent: re-running it redeploys the current tree, reapplies
# migrations, re-seeds curated content, re-runs the lesson setup, and restarts
# the server.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing env var: $name" >&2
    exit 64
  fi
}

require DEPLOY_HOST
require DEPLOY_USER
require DEPLOY_PATH
require DEPLOY_DATABASE_URL

PORT="${DEPLOY_PORT:-3030}"
SSH_PORT="${DEPLOY_SSH_PORT:-22}"
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH="ssh -p ${SSH_PORT}"
RSYNC_RSH="ssh -p ${SSH_PORT}"

echo "───── Phase 1 classroom deploy ─────"
echo "  target     : ${TARGET}:${DEPLOY_PATH}"
echo "  http port  : ${PORT}"
echo "  db url     : ${DEPLOY_DATABASE_URL/:\/\/*@/://***@}"
echo ""

# ---------------------------------------------------------------------------
# 1. Sync source. Exclude build artefacts, dev-only state, and secrets.
# ---------------------------------------------------------------------------
echo "── 1/6 rsync source tree"
${SSH} "${TARGET}" "mkdir -p '${DEPLOY_PATH}'"
rsync -az --delete \
  --rsh="${RSYNC_RSH}" \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='tmp/' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='coverage/' \
  --exclude='*.log' \
  ./ "${TARGET}:${DEPLOY_PATH}/"

# ---------------------------------------------------------------------------
# 2. Ensure a .env exists on the remote. We never overwrite an existing one.
#    A fresh session secret is minted per deploy if the file is missing.
# ---------------------------------------------------------------------------
echo "── 2/6 remote .env bootstrap (only if missing)"
REMOTE_ENV="${DEPLOY_PATH}/.env"
if ! ${SSH} "${TARGET}" "test -f '${REMOTE_ENV}'"; then
  echo "  .env missing on remote — generating from template"
  SESSION_SECRET="$(openssl rand -hex 32)"
  # heredoc is read locally, values expand locally, result written remotely
  ${SSH} "${TARGET}" "cat > '${REMOTE_ENV}'" <<EOF
NODE_ENV=production
PORT=${PORT}
LOG_LEVEL=info
DATABASE_URL=${DEPLOY_DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
LLM_ENABLED=false
OPENAI_API_KEY=
OPENAI_MODEL_MARKING=
OPENAI_MODEL_GENERATION=
OPENAI_MODEL_EMBEDDING=text-embedding-3-small
ADMIN_USERNAME=admin
ADMIN_INITIAL_PASSWORD=change_me_on_first_login
EOF
  echo "  ✓ .env written with a fresh SESSION_SECRET"
else
  echo "  ✓ .env already exists — leaving it alone"
fi

# ---------------------------------------------------------------------------
# 3. Install dependencies + build.
# ---------------------------------------------------------------------------
echo "── 3/6 npm ci + build"
${SSH} "${TARGET}" "cd '${DEPLOY_PATH}' && npm ci && npm run build"

# ---------------------------------------------------------------------------
# 4. Apply migrations + seed curated content.
# ---------------------------------------------------------------------------
echo "── 4/6 migrations + curated content seed"
${SSH} "${TARGET}" "cd '${DEPLOY_PATH}' && npm run --silent db:migrate"
# Seeder can FK-fail on re-runs when attempts exist; we tolerate the benign case.
${SSH} "${TARGET}" "cd '${DEPLOY_PATH}' && (npm run --silent content:seed || echo '  (seed reported non-zero — treat as benign if curated content is already present)')"

# ---------------------------------------------------------------------------
# 5. Run the lesson setup (pupils, class, enrolments, topic).
#    Skip with SKIP_SETUP_LESSON=1 if pupils already exist and you don't want
#    to touch them.
# ---------------------------------------------------------------------------
if [[ "${SKIP_SETUP_LESSON:-0}" == "1" ]]; then
  echo "── 5/6 lesson setup: SKIPPED (SKIP_SETUP_LESSON=1)"
  echo "       You MUST have created the teacher account on the remote first."
else
  echo "── 5/6 lesson setup (idempotent)"
  # Forward any LESSON_* / TEACHER_* overrides to the remote shell.
  # Only forward vars that are actually set so we don't clobber defaults with "".
  REMOTE_ENV_ARGS=()
  for var in TEACHER_USERNAME TEACHER_PASSWORD TEACHER_DISPLAY_NAME TEACHER_PSEUDONYM \
             LESSON_CLASS_NAME LESSON_ACADEMIC_YEAR LESSON_TOPIC_CODE LESSON_PUPIL_COUNT; do
    if [[ -n "${!var:-}" ]]; then
      # Map unprefixed TEACHER_* → LESSON_TEACHER_* as the script expects.
      case "$var" in
        TEACHER_USERNAME)     remote_name="LESSON_TEACHER_USERNAME" ;;
        TEACHER_PASSWORD)     remote_name="LESSON_TEACHER_PASSWORD" ;;
        TEACHER_DISPLAY_NAME) remote_name="LESSON_TEACHER_DISPLAY_NAME" ;;
        TEACHER_PSEUDONYM)    remote_name="LESSON_TEACHER_PSEUDONYM" ;;
        *)                    remote_name="$var" ;;
      esac
      REMOTE_ENV_ARGS+=("${remote_name}=$(printf %q "${!var}")")
    fi
  done
  ${SSH} "${TARGET}" "cd '${DEPLOY_PATH}' && ${REMOTE_ENV_ARGS[*]:-} npm run --silent setup:lesson"
fi

# ---------------------------------------------------------------------------
# 6. Start (or restart) the server. We use a simple nohup + pidfile pattern;
#    switch to systemd later if we keep this server around.
# ---------------------------------------------------------------------------
echo "── 6/6 (re)start server"
${SSH} "${TARGET}" bash -s "${DEPLOY_PATH}" "${PORT}" <<'REMOTE'
set -euo pipefail
DEPLOY_PATH="$1"
PORT="$2"
PIDFILE="${DEPLOY_PATH}/tmp/server.pid"
LOGFILE="${DEPLOY_PATH}/tmp/server.log"
mkdir -p "${DEPLOY_PATH}/tmp"

# Stop an existing instance, if any.
if [[ -f "${PIDFILE}" ]]; then
  old_pid="$(cat "${PIDFILE}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "  stopping existing server (pid ${old_pid})"
    kill "${old_pid}" 2>/dev/null || true
    # Give it a moment to exit cleanly.
    for _ in 1 2 3 4 5; do
      kill -0 "${old_pid}" 2>/dev/null || break
      sleep 1
    done
    kill -9 "${old_pid}" 2>/dev/null || true
  fi
  rm -f "${PIDFILE}"
fi

# Also kill any stray listener on the target port (e.g. prior aborted run).
if command -v ss >/dev/null 2>&1; then
  stray_pid="$(ss -lptn "sport = :${PORT}" 2>/dev/null | awk -F 'pid=' '/pid=/{print $2}' | awk -F ',' '{print $1}' | head -n1)"
  if [[ -n "${stray_pid:-}" ]]; then
    echo "  killing stray listener on :${PORT} (pid ${stray_pid})"
    kill "${stray_pid}" 2>/dev/null || true
  fi
fi

cd "${DEPLOY_PATH}"
nohup npm run start > "${LOGFILE}" 2>&1 &
echo $! > "${PIDFILE}"
new_pid="$(cat "${PIDFILE}")"
echo "  started server (pid ${new_pid}), log: ${LOGFILE}"

# Health check (poll up to ~20s).
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "  ✓ /healthz responded after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "  ✗ server did not answer /healthz within 20s — see ${LOGFILE}" >&2
exit 1
REMOTE

echo ""
echo "✓ Deploy complete."
echo "  Teacher sign-in:  http://${DEPLOY_HOST}:${PORT}/login"
echo "  Logs (on remote): ${DEPLOY_PATH}/tmp/server.log"
echo "  Stop the server:  ssh -p ${SSH_PORT} ${TARGET} 'kill \$(cat ${DEPLOY_PATH}/tmp/server.pid)'"
