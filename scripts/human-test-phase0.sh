#!/usr/bin/env bash
# Interactive Phase 0 sign-off walker.
#
# Walks the human through HUMAN_TEST_GUIDE.md §Phase 0 step-by-step.
# Runs deterministic commands itself (docker/psql/curl), prompts the
# human only for things a human must verify (what they see on screen,
# whether a textarea cleared, whether a flash read correctly).
#
# Writes a timestamped markdown report to tmp/human-tests/phase0-<ts>.md
# capturing every verdict, captured stdout/stderr, and DB snapshots.
# The report is what you attach to RUNBOOK.md §10 sign-off.
#
# Usage:
#   npm run test:human:phase0              # from project root
#   bash scripts/human-test-phase0.sh
#   bash scripts/human-test-phase0.sh --step 7     # resume at step 7
#   bash scripts/human-test-phase0.sh --no-preflight
#
# Exits 0 only if every step was marked PASS. Any FAIL or SKIP in a
# step that requires verification exits non-zero so CI wrappers (if
# any) notice.

set -uo pipefail

# ---------------------------------------------------------------------------
# Constants / environment
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_DIR="${ROOT_DIR}/tmp/human-tests"
REPORT="${REPORT_DIR}/phase0-${TS}.md"
mkdir -p "$REPORT_DIR"

START_STEP=1
DO_PREFLIGHT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --step) START_STEP="$2"; shift 2 ;;
    --no-preflight) DO_PREFLIGHT=0; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
done

# Teacher / pupil fixtures created for this walk.
HTG_TEACHER_USER="htg_teacher"
HTG_TEACHER_PW="htg-teacher-pw-1"
HTG_PUPIL_USER="htg_pupil"
HTG_PUPIL_PW="htg-pupil-pw-1"

APP_URL="${APP_URL:-http://localhost:3030}"

# ANSI colours (disabled if stdout isn't a tty).
if [[ -t 1 ]]; then
  C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'; C_RESET=$'\e[0m'
  C_CYAN=$'\e[36m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'
else
  C_DIM=""; C_BOLD=""; C_RESET=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

# Counters (used in the exit trap).
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
declare -a FAILED_STEPS=()

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

report() { printf '%s\n' "$*" >>"$REPORT"; }

say()   { printf '\n%s%s%s\n' "$C_CYAN$C_BOLD" "$*" "$C_RESET"; }
inst()  { printf '  %s\n' "$*"; }
hint()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()    { printf '  %s✓ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn()  { printf '  %s! %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
err()   { printf '  %s✗ %s%s\n' "$C_RED" "$*" "$C_RESET"; }

# ask_pf "prompt" → sets REPLY_VERDICT to PASS|FAIL|SKIP (and REPLY_NOTE)
# and appends a verdict block to the report. Also updates counters.
ask_pf() {
  local prompt="$1"
  local step_id="${2:-}"
  local verdict=""
  local note=""
  while true; do
    printf '\n%s%s%s [P]ass / [F]ail / [S]kip / [Q]uit > ' "$C_BOLD" "$prompt" "$C_RESET"
    read -r answer
    case "${answer^^}" in
      P|PASS) verdict="PASS"; break ;;
      F|FAIL) verdict="FAIL"; break ;;
      S|SKIP) verdict="SKIP"; break ;;
      Q|QUIT)
        warn "Quitting — partial report at $REPORT"
        exit 130 ;;
      *) hint "Please type P, F, S or Q." ;;
    esac
  done
  if [[ "$verdict" != "PASS" ]]; then
    printf '  Note (enter to skip): '
    read -r note
  fi
  REPLY_VERDICT="$verdict"
  REPLY_NOTE="$note"
  case "$verdict" in
    PASS) PASS_COUNT=$((PASS_COUNT+1)); ok "Recorded PASS" ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1)); FAILED_STEPS+=("$step_id"); err "Recorded FAIL" ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT+1)); warn "Recorded SKIP" ;;
  esac
  report ""
  report "**Verdict: ${verdict}**"
  if [[ -n "$note" ]]; then
    report ""
    report "> ${note}"
  fi
  report ""
}

step_header() {
  local n="$1"; shift
  local title="$*"
  say "── Step ${n}: ${title} ──"
  report ""
  report "## Step ${n} — ${title}"
  report ""
}

# Run a command and tee its combined output into the report as a collapsed block.
run_capture() {
  local label="$1"; shift
  local tmp; tmp="$(mktemp)"
  printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_RESET"
  ( "$@" ) >"$tmp" 2>&1
  local rc=$?
  sed 's/^/    /' "$tmp"
  report "<details><summary>${label} (exit ${rc})</summary>"
  report ""
  report '```'
  report "\$ $*"
  cat "$tmp" >>"$REPORT"
  report '```'
  report "</details>"
  report ""
  rm -f "$tmp"
  return $rc
}

# Run a single SQL statement in the dev Postgres container. Streams output to
# the console AND the report, then exits 0/1 based on psql's exit code.
psql_capture() {
  local label="$1"; local sql="$2"
  run_capture "$label" docker compose exec -T postgres psql -U exam -d exam_dev -XAt -c "$sql"
}

# Fetch a scalar (first cell of first row) from the dev DB.
psql_scalar() {
  local sql="$1"
  docker compose exec -T postgres psql -U exam -d exam_dev -XAt -c "$sql" 2>/dev/null | head -n1
}

# ---------------------------------------------------------------------------
# Exit trap — always write a summary so a quit/failure leaves a useful trail.
# ---------------------------------------------------------------------------

summarise() {
  local rc=$?
  report ""
  report "---"
  report ""
  report "## Summary"
  report ""
  report "| Metric | Count |"
  report "|---|---|"
  report "| Steps PASSED | ${PASS_COUNT} |"
  report "| Steps FAILED | ${FAIL_COUNT} |"
  report "| Steps SKIPPED | ${SKIP_COUNT} |"
  if (( ${#FAILED_STEPS[@]} > 0 )); then
    report ""
    report "Failed steps: ${FAILED_STEPS[*]}"
  fi
  report ""
  report "Ended: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report ""
  if (( FAIL_COUNT == 0 && SKIP_COUNT == 0 )); then
    report "**Overall: PASS** — safe to sign off Phase 0 in RUNBOOK.md §10."
    report ""
    report "Suggested RUNBOOK.md §10 line:"
    report ""
    report "    ${TS} — <initials> — Phase 0 human test — PASS (report: ${REPORT#${ROOT_DIR}/})"
  else
    report "**Overall: NOT PASS** — do not sign off Phase 0 until the failed/skipped steps are resolved."
  fi

  printf '\n%s──────── Summary ────────%s\n' "$C_BOLD" "$C_RESET"
  printf '  %sPASS%s: %d   %sFAIL%s: %d   %sSKIP%s: %d\n' \
    "$C_GREEN" "$C_RESET" "$PASS_COUNT" \
    "$C_RED"   "$C_RESET" "$FAIL_COUNT" \
    "$C_YELLOW" "$C_RESET" "$SKIP_COUNT"
  printf '  Report: %s\n\n' "$REPORT"
  exit "$rc"
}
trap summarise EXIT

# ---------------------------------------------------------------------------
# Report header
# ---------------------------------------------------------------------------

report "# Phase 0 human test — ${TS}"
report ""
report "- Project: exam_questions (OCR J277 revision platform)"
report "- Run by: $(id -un 2>/dev/null || echo unknown)@$(hostname -s 2>/dev/null || echo unknown)"
report "- Script: scripts/human-test-phase0.sh"
report "- Maps to: [HUMAN_TEST_GUIDE.md](../../HUMAN_TEST_GUIDE.md) §Phase 0"
report "- Start step: ${START_STEP}"
report ""
report "Every verdict below is the human operator's, entered at the prompt."
report "Captured command output is inside collapsed \`<details>\` blocks."
report ""

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if (( DO_PREFLIGHT )); then
  say "Preflight"
  report "## Preflight"
  report ""

  inst "Checking Docker is up and the postgres container is running..."
  if ! docker compose ps postgres 2>/dev/null | grep -qi 'running\|up'; then
    warn "Postgres container is not running. Starting it with 'npm run db:up'..."
    run_capture "npm run db:up" npm run --silent db:up
  else
    ok "postgres container is running"
    report "- postgres container: running"
  fi

  inst "Applying migrations (npm run db:migrate)..."
  if run_capture "npm run db:migrate" npm run --silent db:migrate; then
    ok "migrations applied (or already up to date)"
  else
    err "db:migrate failed — stop here and fix the migration before re-running."
    exit 2
  fi

  inst "Running the automated suite (npm run check). This takes ~30s."
  printf '  Run it now? [Y/n] > '
  read -r run_check
  case "${run_check:-Y}" in
    n|N) warn "Skipping npm run check (you MUST have a green run on this commit before sign-off)."
         report "- npm run check: SKIPPED (human declined)" ;;
    *)
      if run_capture "npm run check" npm run --silent check; then
        ok "npm run check green"
      else
        err "npm run check failed — fix regressions before continuing."
        printf '  Continue anyway? [y/N] > '
        read -r cont
        [[ "${cont:-N}" =~ ^[Yy]$ ]] || exit 3
      fi
      ;;
  esac

  inst "Ensuring the dev server is reachable at ${APP_URL}/healthz..."
  if curl -fsS --max-time 3 "${APP_URL}/healthz" >/dev/null 2>&1; then
    ok "dev server answering on ${APP_URL}"
    report "- dev server: reachable at ${APP_URL}"
  else
    warn "Dev server not reachable. In another terminal run: npm run dev"
    warn "Wait until you see 'Server listening on 0.0.0.0:3030', then press enter here."
    read -r _
    if curl -fsS --max-time 3 "${APP_URL}/healthz" >/dev/null 2>&1; then
      ok "dev server now reachable"
    else
      err "Still unreachable. Aborting."
      exit 4
    fi
  fi

  inst "Creating fixture users ${HTG_TEACHER_USER} and ${HTG_PUPIL_USER} (idempotent)..."
  run_capture "create ${HTG_TEACHER_USER}" \
    npm run --silent user:create -- \
      --role teacher --username "$HTG_TEACHER_USER" \
      --display-name "HTG Teacher" --pseudonym TEA-HTG-01 \
      --password "$HTG_TEACHER_PW"
  run_capture "create ${HTG_PUPIL_USER}" \
    npm run --silent user:create -- \
      --role pupil --username "$HTG_PUPIL_USER" \
      --display-name "HTG Pupil" --pseudonym PUP-HTG-01 \
      --password "$HTG_PUPIL_PW"
fi

# Baseline counters we reuse in later steps.
INITIAL_ATTEMPT_COUNT="$(psql_scalar 'SELECT count(*) FROM attempts;')"
INITIAL_ATTEMPT_COUNT="${INITIAL_ATTEMPT_COUNT:-0}"
report ""
report "Initial \`attempts\` row count (baseline for reboot check): **${INITIAL_ATTEMPT_COUNT}**"
report ""

# ---------------------------------------------------------------------------
# Helpers used across steps
# ---------------------------------------------------------------------------

run_if_ge() { local want="$1"; shift; (( START_STEP <= want )) && "$@"; }

audit_count_since() {
  # $1 event_type ; $2 iso timestamp lower bound
  # NB: audit_events.at is the timestamp column (see migrations/0003_audit.sql).
  local ev="$1" since="$2"
  psql_scalar "SELECT count(*) FROM audit_events WHERE event_type='${ev}' AND at >= timestamptz '${since}';"
}

pause() {
  printf '\n  %s[enter]%s when done ' "$C_DIM" "$C_RESET"
  read -r _
}

# ---------------------------------------------------------------------------
# Step 1 — anonymous / redirects to /login
# ---------------------------------------------------------------------------
step1() {
  step_header 1 "Anonymous root redirects to /login"
  inst "Open ${APP_URL}/ in a FRESH PRIVATE window."
  inst "Expected: redirects to /login; form shows 'Sign in' with username + password fields."
  inst "Automated sanity check follows (curl, no cookies):"
  run_capture "curl -sI ${APP_URL}/" curl -sI --max-time 5 "${APP_URL}/"
  ask_pf "Did the private-window browser redirect you to a 'Sign in' form?" "1"
}
run_if_ge 1 step1

# ---------------------------------------------------------------------------
# Step 2 — CSRF cookie and hidden input
# ---------------------------------------------------------------------------
step2() {
  step_header 2 "CSRF token present in HTML and cookie"
  inst "In the private window, view source on /login and confirm:"
  inst "  - there is a hidden <input type=\"hidden\" name=\"_csrf\" value=\"...\">"
  inst "  - the response set a _csrf=... cookie (Devtools → Application → Cookies)"
  inst "Automated checks:"
  run_capture "curl -i ${APP_URL}/login" curl -isS --max-time 5 "${APP_URL}/login"
  local hidden csrf_cookie
  hidden=$(curl -sS "${APP_URL}/login" | grep -oE 'name="_csrf" value="[^"]+"' | head -n1 || true)
  csrf_cookie=$(curl -sSI "${APP_URL}/login" | grep -i '^set-cookie:.*_csrf=' || true)
  if [[ -n "$hidden" ]]; then ok "Found hidden CSRF input: $hidden"; else err "No hidden _csrf input in /login body!"; fi
  if [[ -n "$csrf_cookie" ]]; then ok "Set-Cookie _csrf present"; else err "No _csrf Set-Cookie header!"; fi
  report ""
  report "- Hidden input match: \`${hidden:-<none>}\`"
  report "- Set-Cookie line:    \`${csrf_cookie:-<none>}\`"
  ask_pf "Did the browser show both the hidden input AND the _csrf cookie?" "2"
}
run_if_ge 2 step2

# ---------------------------------------------------------------------------
# Step 3 — CSRF rejection (script-driven, no human action needed)
# ---------------------------------------------------------------------------
step3() {
  step_header 3 "POST /login without a CSRF token is rejected"
  inst "Sending a bare POST /login (no CSRF cookie / token). Expected: HTTP 403."
  local code
  code=$(curl -s -o /tmp/phase0_step3_body -w '%{http_code}' \
           --max-time 5 \
           -X POST \
           -H 'content-type: application/x-www-form-urlencoded' \
           --data 'username=foo&password=bar' \
           "${APP_URL}/login" || echo "000")
  inst "Returned HTTP ${code}."
  report ""
  report "- HTTP status: \`${code}\`"
  report ""
  if [[ -s /tmp/phase0_step3_body ]]; then
    report "<details><summary>Response body</summary>"
    report ""
    report '```'
    cat /tmp/phase0_step3_body >>"$REPORT"
    report ""
    report '```'
    report "</details>"
    report ""
  fi
  rm -f /tmp/phase0_step3_body
  if [[ "$code" == "403" ]]; then
    ok "CSRF middleware correctly rejected the request (HTTP 403)"
  else
    err "Expected HTTP 403 but got ${code} — CSRF protection may be misconfigured."
  fi
  ask_pf "Does the status code above match the expected 403?" "3"
}
run_if_ge 3 step3

# ---------------------------------------------------------------------------
# Step 4 — Bad password flash + audit row
# ---------------------------------------------------------------------------
step4() {
  step_header 4 "Bad password: flash + audit.login.failed"
  local before="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  report "- Baseline timestamp for audit count: \`${before}\`"
  inst "In the private window, sign in as '${HTG_TEACHER_USER}' with a DELIBERATELY WRONG password."
  inst "Expected: red flash reads 'Username or password is incorrect.'"
  pause
  inst "Checking audit_events for a new 'auth.login.failed' / 'bad_password' row..."
  psql_capture "audit rows since ${before}" \
    "SELECT event_type, details::text, at
       FROM audit_events
      WHERE at >= timestamptz '${before}'
      ORDER BY id DESC
      LIMIT 5;"
  local n
  n=$(psql_scalar "SELECT count(*) FROM audit_events
                    WHERE event_type='auth.login.failed'
                      AND details->>'reason'='bad_password'
                      AND at >= timestamptz '${before}';")
  if [[ "${n:-0}" -ge 1 ]]; then
    ok "Found ${n} 'auth.login.failed / bad_password' row(s) after ${before}"
  else
    err "No 'auth.login.failed / bad_password' audit row after ${before}"
  fi
  ask_pf "Flash correct AND at least one new audit row matched?" "4"
}
run_if_ge 4 step4

# ---------------------------------------------------------------------------
# Step 5 — Good login → /q/1 + session row + audit
# ---------------------------------------------------------------------------
step5() {
  step_header 5 "Good teacher login → /q/1 + session + audit"
  local before="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  inst "In the private window, sign in as '${HTG_TEACHER_USER}' / '${HTG_TEACHER_PW}'."
  inst "Expected: redirects to /q/1. Page title 'Question 1'."
  pause
  psql_capture "teacher sessions" \
    "SELECT id, user_id, expires_at, last_seen_at
       FROM sessions
      WHERE user_id = (SELECT id FROM users WHERE username='${HTG_TEACHER_USER}')
      ORDER BY last_seen_at DESC
      LIMIT 3;"
  local sess_n audit_n
  sess_n=$(psql_scalar "SELECT count(*) FROM sessions
                         WHERE user_id = (SELECT id FROM users WHERE username='${HTG_TEACHER_USER}')
                           AND expires_at > now();")
  audit_n=$(audit_count_since "auth.login.ok" "$before")
  if [[ "${sess_n:-0}" -ge 1 ]]; then ok "Teacher has ${sess_n} live session row(s)"; else err "No live session row for teacher."; fi
  if [[ "${audit_n:-0}" -ge 1 ]]; then ok "New auth.login.ok audit row(s): ${audit_n}"; else err "No auth.login.ok audit row after ${before}."; fi
  ask_pf "Redirected to /q/1 AND DB state matches?" "5"
}
run_if_ge 5 step5

# ---------------------------------------------------------------------------
# Step 6 — Question card contents
# ---------------------------------------------------------------------------
step6() {
  step_header 6 "Question card: badges / stem / part (a)"
  inst "On /q/1, confirm the card shows:"
  inst "  Badges: Question 1 · 1.1 · 1.1.1 · describe · 2 marks"
  inst "  Stem:   'Inside the CPU is the Arithmetic Logic Unit (ALU).'"
  inst "  Part:   '(a) Describe the purpose of the ALU. [2 marks]' with a textarea."
  ask_pf "Everything present and readable?" "6"
}
run_if_ge 6 step6

# ---------------------------------------------------------------------------
# Step 7 — Teacher submits an answer
# ---------------------------------------------------------------------------
step7() {
  step_header 7 "Teacher submits an answer (attempt + question + part written)"
  local before="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  inst "Type in the textarea: 'It performs arithmetic and logical operations on data.'"
  inst "Click Submit answer."
  inst "Expected: redirect to /q/1?saved=N ; green flash 'Submitted. Saved as attempt #N.' ; textarea empty."
  pause
  psql_capture "teacher attempt chain since ${before}" \
    "SELECT a.id          AS attempt_id,
            a.submitted_at,
            a.mode,
            aq.id          AS attempt_question_id,
            ap.raw_answer
       FROM attempts a
       JOIN attempt_questions aq ON aq.attempt_id = a.id
       JOIN attempt_parts ap     ON ap.attempt_question_id = aq.id
      WHERE a.user_id = (SELECT id FROM users WHERE username='${HTG_TEACHER_USER}')
        AND a.submitted_at >= timestamptz '${before}'
      ORDER BY a.id DESC
      LIMIT 5;"
  local rows audit_n
  rows=$(psql_scalar "SELECT count(*) FROM attempts a
                       WHERE a.user_id = (SELECT id FROM users WHERE username='${HTG_TEACHER_USER}')
                         AND a.submitted_at >= timestamptz '${before}';")
  audit_n=$(audit_count_since "attempt.submitted" "$before")
  if [[ "${rows:-0}" -ge 1 ]]; then ok "Teacher has ${rows} new submitted attempt(s) since ${before}"; else err "No new submitted attempt for teacher."; fi
  if [[ "${audit_n:-0}" -ge 1 ]]; then ok "audit.attempt.submitted row(s): ${audit_n}"; else err "No attempt.submitted audit row."; fi
  ask_pf "?saved=N redirect + flash correct AND DB rows present?" "7"
}
run_if_ge 7 step7

# ---------------------------------------------------------------------------
# Step 8 — Pupil sees form, not teacher's answer
# ---------------------------------------------------------------------------
step8() {
  step_header 8 "Second private window — pupil sees form, not teacher's answer"
  inst "Open a SECOND private window. Sign in as '${HTG_PUPIL_USER}' / '${HTG_PUPIL_PW}'."
  inst "Expected: redirects to /q/1 with an EMPTY textarea."
  inst "Crucial: pupil must NOT see the teacher's submitted answer on their /q/1."
  pause
  ask_pf "Pupil redirected to /q/1 AND no teacher answer visible?" "8"
}
run_if_ge 8 step8

# ---------------------------------------------------------------------------
# Step 9 — Pupil submits their own answer
# ---------------------------------------------------------------------------
step9() {
  step_header 9 "Pupil submits a different answer (attributed to pupil)"
  local before="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  inst "In the pupil window, type a DIFFERENT answer and submit."
  inst "Expected: new ?saved=N redirect with a different attempt id."
  pause
  psql_capture "pupil attempt chain since ${before}" \
    "SELECT a.id AS attempt_id, a.user_id, u.username, ap.raw_answer
       FROM attempts a
       JOIN users u             ON u.id = a.user_id
       JOIN attempt_questions aq ON aq.attempt_id = a.id
       JOIN attempt_parts ap     ON ap.attempt_question_id = aq.id
      WHERE a.submitted_at >= timestamptz '${before}'
      ORDER BY a.id DESC
      LIMIT 5;"
  local pupil_rows teacher_leak
  pupil_rows=$(psql_scalar "SELECT count(*) FROM attempts
                             WHERE user_id = (SELECT id FROM users WHERE username='${HTG_PUPIL_USER}')
                               AND submitted_at >= timestamptz '${before}';")
  teacher_leak=$(psql_scalar "SELECT count(*) FROM attempts
                               WHERE user_id = (SELECT id FROM users WHERE username='${HTG_TEACHER_USER}')
                                 AND submitted_at >= timestamptz '${before}';")
  if [[ "${pupil_rows:-0}" -ge 1 ]]; then ok "Pupil has ${pupil_rows} new submitted attempt(s)."; else err "No pupil attempt since ${before}."; fi
  if [[ "${teacher_leak:-0}" -eq 0 ]]; then ok "No teacher attempts created during pupil step (good)."; else err "A teacher attempt appeared during pupil step — attribution bug!"; fi
  ask_pf "New pupil attempt present AND attributed to pupil.user_id?" "9"
}
run_if_ge 9 step9

# ---------------------------------------------------------------------------
# Step 10 — Anonymous /q/1 → /login
# ---------------------------------------------------------------------------
step10() {
  step_header 10 "Third window, signed out — /q/1 redirects to /login"
  inst "Open a THIRD private window (or a curl). Hit ${APP_URL}/q/1."
  run_capture "curl -sI ${APP_URL}/q/1" curl -sI --max-time 5 "${APP_URL}/q/1"
  local loc
  loc=$(curl -sI --max-time 5 "${APP_URL}/q/1" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
  report "- Location header: \`${loc:-<none>}\`"
  if [[ "${loc:-}" == */login* ]]; then ok "Anonymous /q/1 redirects to /login"; else err "Expected a Location header to /login, got '${loc}'"; fi
  ask_pf "Anonymous /q/1 redirects to /login?" "10"
}
run_if_ge 10 step10

# ---------------------------------------------------------------------------
# Step 11 — /healthz
# ---------------------------------------------------------------------------
step11() {
  step_header 11 "/healthz returns { ok: true }"
  run_capture "curl ${APP_URL}/healthz" curl -sS --max-time 5 "${APP_URL}/healthz"
  local body
  body=$(curl -sS --max-time 5 "${APP_URL}/healthz" || echo "")
  if [[ "$body" == '{"ok":true}' ]]; then ok "Exact JSON match: {\"ok\":true}"; else warn "Body was: $body"; fi
  ask_pf "/healthz returned { ok: true }?" "11"
}
run_if_ge 11 step11

# ---------------------------------------------------------------------------
# 0.C — Reboot survival (steps 12–16)
# ---------------------------------------------------------------------------
step12() {
  step_header 12 "Count attempts before reboot"
  local n
  n=$(psql_scalar "SELECT count(*) FROM attempts;")
  report "- \`attempts\` count before reboot: **${n}**"
  export PRE_REBOOT_ATTEMPTS="${n:-0}"
  if [[ "${PRE_REBOOT_ATTEMPTS}" -ge 2 ]]; then
    ok "Count is ${PRE_REBOOT_ATTEMPTS} (≥2: teacher + pupil)."
  else
    warn "Count is ${PRE_REBOOT_ATTEMPTS} — step 7/9 might not have been sealed."
  fi
  ask_pf "Baseline count recorded (expecting ≥2)?" "12"
}
run_if_ge 12 step12

step13() {
  step_header 13 "Stop dev server and DB container"
  inst "In the dev-server terminal, press Ctrl-C to stop 'npm run dev'."
  inst "Then this script will run 'npm run db:down'."
  printf '  Ready? [enter to continue, q to quit] '
  read -r r; [[ "${r,,}" == "q" ]] && exit 130
  run_capture "npm run db:down" npm run --silent db:down
  ask_pf "DB container stopped cleanly?" "13"
}
run_if_ge 13 step13

step14() {
  step_header 14 "Restart DB + migrations + dev server"
  run_capture "npm run db:up" npm run --silent db:up
  inst "Waiting 4s for Postgres to accept connections..."
  sleep 4
  run_capture "npm run db:migrate" npm run --silent db:migrate
  inst "Now, in your dev-server terminal, start 'npm run dev'."
  inst "Wait for 'Server listening on 0.0.0.0:3030' and press enter."
  pause
  if curl -fsS --max-time 4 "${APP_URL}/healthz" >/dev/null 2>&1; then
    ok "Dev server back on ${APP_URL}"
  else
    err "Dev server not reachable after restart."
  fi
  ask_pf "Migrations reported 0 pending AND dev server back up?" "14"
}
run_if_ge 14 step14

step15() {
  step_header 15 "Re-count attempts — data survived reboot"
  local n
  n=$(psql_scalar "SELECT count(*) FROM attempts;")
  report "- \`attempts\` count after reboot: **${n}**"
  report "- baseline from step 12: **${PRE_REBOOT_ATTEMPTS:-?}**"
  if [[ "${n:-0}" == "${PRE_REBOOT_ATTEMPTS:-X}" ]]; then
    ok "Counts match (${n}) — data survived."
  else
    err "MISMATCH: before=${PRE_REBOOT_ATTEMPTS:-?} after=${n:-?} — data did NOT survive."
  fi
  ask_pf "Post-reboot count matches baseline?" "15"
}
run_if_ge 15 step15

step16() {
  step_header 16 "Teacher window refresh — session state check"
  inst "Go back to the teacher's private window and refresh."
  inst "Expected: either still on /q/1 (session still valid) OR back on /login (cookie cleared)."
  inst "Either is acceptable; record which one you saw."
  ask_pf "Behaviour matched cookie state (pick FAIL only if something else happened)?" "16"
}
run_if_ge 16 step16

# ---------------------------------------------------------------------------
# 0.D — Backup and restore drill (steps 17–19)
# ---------------------------------------------------------------------------
step17() {
  step_header 17 "npm run db:backup"
  run_capture "npm run db:backup" npm run --silent db:backup
  inst "Latest backup files:"
  run_capture "ls -lh ./tmp/backups" bash -c 'ls -lh ./tmp/backups 2>/dev/null | tail -n 10 || true'
  ask_pf "A new .dump (+ .sha256 sibling) is in ./tmp/backups?" "17"
}
run_if_ge 17 step17

step18() {
  step_header 18 "npm run db:restore-drill"
  if run_capture "npm run db:restore-drill" npm run --silent db:restore-drill; then
    ok "restore-drill exited 0"
  else
    err "restore-drill exited non-zero — fix before signing off."
  fi
  ask_pf "Last line read 'PASS: N users, ..., ..., curriculum 2/11/26/29' and scratch DB dropped?" "18"
}
run_if_ge 18 step18

step19() {
  step_header 19 "Record drill in RUNBOOK.md §10"
  inst "Add ONE line under [RUNBOOK.md](RUNBOOK.md) §10:"
  inst "  ${TS} — <initials> — First restore drill — PASS — <counts>"
  ask_pf "Entry added to RUNBOOK.md?" "19"
}
run_if_ge 19 step19

# End of walkthrough. The EXIT trap writes the summary.
