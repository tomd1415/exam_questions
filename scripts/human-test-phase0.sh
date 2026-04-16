#!/usr/bin/env bash
# Phase 0 sign-off walker, automated end-to-end.
#
# Walks HUMAN_TEST_GUIDE.md §Phase 0 with the maximum amount of work
# done by the script:
#   - mechanical HTTP checks (steps 1, 2, 3, 10, 11) → curl + assert,
#     no prompt
#   - browser-driven flows (steps 4-9) → Playwright/Chromium drives
#     login, view, submit, pupil isolation, and asserts on the rendered
#     HTML; the bash walker reads a JSON result file
#   - reboot survival (steps 12-15) → bash records the row count,
#     prompts the human only to confirm "ready to stop the DB" and
#     "dev server back up", then re-counts and asserts
#   - post-reboot session check (step 16) → Playwright reloads saved
#     teacher cookies and asserts /q/1 either renders or redirects to
#     /login
#   - backup + restore drill (steps 17, 18) → fully scripted; verifies
#     a new .dump + .sha256 landed and the drill exited PASS
#   - RUNBOOK.md entry (step 19) → reminder only, never auto-pass
#
# A timestamped markdown report lands at
# tmp/human-tests/phase0-<utc-ts>.md with every captured stdout/stderr,
# every verdict (auto or human), and links to any Playwright failure
# screenshots.
#
# Usage:
#   npm run test:human:phase0
#   bash scripts/human-test-phase0.sh --step 7        # resume from step 7
#   bash scripts/human-test-phase0.sh --no-preflight  # skip preflight
#
# Exits 0 only if every step passed.

set -uo pipefail

# ---------------------------------------------------------------------------
# Constants / environment
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_DIR="${ROOT_DIR}/tmp/human-tests"
REPORT="${REPORT_DIR}/phase0-${TS}.md"
SCREENSHOT_DIR="${REPORT_DIR}/phase0-${TS}-screenshots"
BROWSER_OUT_PRIMARY="${REPORT_DIR}/phase0-${TS}-browser-primary.json"
BROWSER_OUT_REBOOT="${REPORT_DIR}/phase0-${TS}-browser-postreboot.json"
STORAGE_PATH="${REPORT_DIR}/phase0-${TS}-storage.json"
mkdir -p "$REPORT_DIR" "$SCREENSHOT_DIR"

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

HTG_TEACHER_USER="htg_teacher"
HTG_TEACHER_PW="htg-teacher-pw-1"
HTG_PUPIL_USER="htg_pupil"
HTG_PUPIL_PW="htg-pupil-pw-1"

APP_URL="${APP_URL:-http://localhost:3030}"

if [[ -t 1 ]]; then
  C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'; C_RESET=$'\e[0m'
  C_CYAN=$'\e[36m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'
else
  C_DIM=""; C_BOLD=""; C_RESET=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

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

step_header() {
  local n="$1"; shift
  local title="$*"
  say "── Step ${n}: ${title} ──"
  report ""
  report "## Step ${n} — ${title}"
  report ""
}

# Record an auto-determined verdict for a step. No human prompt.
record_auto() {
  local step_id="$1" verdict="$2" notes="$3"
  case "$verdict" in
    PASS) PASS_COUNT=$((PASS_COUNT+1)); ok "PASS — ${notes}" ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1)); FAILED_STEPS+=("$step_id"); err "FAIL — ${notes}" ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT+1)); warn "SKIP — ${notes}" ;;
  esac
  report ""
  report "**Verdict (auto): ${verdict}** — ${notes}"
  report ""
}

# Ask the human for a PASS/FAIL/SKIP — used only when eyeballs are unavoidable.
ask_pf() {
  local prompt="$1" step_id="${2:-}"
  local verdict="" note=""
  while true; do
    printf '\n%s%s%s [P]ass / [F]ail / [S]kip / [Q]uit > ' "$C_BOLD" "$prompt" "$C_RESET"
    read -r answer
    case "${answer^^}" in
      P|PASS) verdict="PASS"; break ;;
      F|FAIL) verdict="FAIL"; break ;;
      S|SKIP) verdict="SKIP"; break ;;
      Q|QUIT) warn "Quitting — partial report at $REPORT"; exit 130 ;;
      *) hint "Please type P, F, S or Q." ;;
    esac
  done
  if [[ "$verdict" != "PASS" ]]; then
    printf '  Note (enter to skip): '
    read -r note
  fi
  case "$verdict" in
    PASS) PASS_COUNT=$((PASS_COUNT+1)); ok "Recorded PASS" ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1)); FAILED_STEPS+=("$step_id"); err "Recorded FAIL" ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT+1)); warn "Recorded SKIP" ;;
  esac
  report ""
  report "**Verdict (human): ${verdict}**"
  if [[ -n "$note" ]]; then
    report ""
    report "> ${note}"
  fi
  report ""
}

# Run a command, tee combined output into the report as a collapsed block.
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

# Run one SQL statement in the dev Postgres container; stream output and
# capture into the report as a collapsed block.
psql_capture() {
  local label="$1" sql="$2"
  run_capture "$label" docker compose exec -T postgres psql -U exam -d exam_dev -XAt -c "$sql"
}

# Fetch a scalar (first cell of first row) from the dev DB. No console output.
psql_scalar() {
  local sql="$1"
  docker compose exec -T postgres psql -U exam -d exam_dev -XAt -c "$sql" 2>/dev/null | head -n1
}

# Convenience: read one step result from a phase0-browser.ts JSON file.
# $1 = json path, $2 = step number, $3 = field (status|notes|screenshot)
browser_step_field() {
  local json="$1" step="$2" field="$3"
  node -e "
    const fs=require('node:fs');
    const d=JSON.parse(fs.readFileSync('${json}','utf8'));
    const s=d.steps && d.steps['${step}'];
    if (!s) { process.stdout.write(''); }
    else { process.stdout.write(String(s.${field}||'')); }
  " 2>/dev/null
}

audit_count_since() {
  # NB: audit_events.at is the timestamp column (see migrations/0003_audit.sql).
  local ev="$1" since="$2"
  psql_scalar "SELECT count(*) FROM audit_events WHERE event_type='${ev}' AND at >= timestamptz '${since}';"
}

run_if_ge() { local want="$1"; shift; (( START_STEP <= want )) && "$@"; }

pause_for_human() {
  printf '\n  %s%s%s [enter to continue, q to quit] ' "$C_BOLD" "$*" "$C_RESET"
  read -r r
  [[ "${r,,}" == "q" ]] && exit 130
}

# ---------------------------------------------------------------------------
# Exit trap — always write the summary
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
report "- Browser driver: scripts/phase0-browser.ts (Playwright/Chromium, headless)"
report "- Maps to: [HUMAN_TEST_GUIDE.md](../../HUMAN_TEST_GUIDE.md) §Phase 0"
report "- Start step: ${START_STEP}"
report ""
report "Verdicts marked **(auto)** were determined by the script."
report "Verdicts marked **(human)** required a person at the keyboard."
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

INITIAL_ATTEMPT_COUNT="$(psql_scalar 'SELECT count(*) FROM attempts;')"
INITIAL_ATTEMPT_COUNT="${INITIAL_ATTEMPT_COUNT:-0}"
report ""
report "Initial \`attempts\` row count: **${INITIAL_ATTEMPT_COUNT}**"
report ""

# ---------------------------------------------------------------------------
# Steps 1, 2, 3 — fully automated HTTP checks (no human prompt)
# ---------------------------------------------------------------------------
step1() {
  step_header 1 "Anonymous root redirects to /login"
  run_capture "curl -sI ${APP_URL}/" curl -sI --max-time 5 "${APP_URL}/"
  local loc
  loc=$(curl -sI --max-time 5 "${APP_URL}/" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
  if [[ "${loc:-}" == */login* ]]; then
    record_auto 1 PASS "Location: ${loc}"
  else
    record_auto 1 FAIL "expected redirect to /login, Location header was '${loc:-<none>}'"
  fi
}
run_if_ge 1 step1

step2() {
  step_header 2 "CSRF token present in HTML and cookie"
  run_capture "curl -i ${APP_URL}/login" curl -isS --max-time 5 "${APP_URL}/login"
  local hidden cookie
  hidden=$(curl -sS --max-time 5 "${APP_URL}/login" | grep -oE 'name="_csrf" value="[^"]+"' | head -n1 || true)
  cookie=$(curl -sSI --max-time 5 "${APP_URL}/login" | grep -i '^set-cookie:.*_csrf=' | head -n1 || true)
  report "- Hidden input: \`${hidden:-<none>}\`"
  report "- Set-Cookie:   \`${cookie:-<none>}\`"
  if [[ -n "$hidden" && -n "$cookie" ]]; then
    record_auto 2 PASS "found hidden _csrf input AND Set-Cookie _csrf header"
  else
    record_auto 2 FAIL "missing hidden=${hidden:+yes}${hidden:-no}, cookie=${cookie:+yes}${cookie:-no}"
  fi
}
run_if_ge 2 step2

step3() {
  step_header 3 "POST /login without CSRF token is rejected (403)"
  local body_file; body_file="$(mktemp)"
  local code
  code=$(curl -s -o "$body_file" -w '%{http_code}' \
           --max-time 5 \
           -X POST \
           -H 'content-type: application/x-www-form-urlencoded' \
           --data 'username=foo&password=bar' \
           "${APP_URL}/login" || echo "000")
  report "<details><summary>response body</summary>"
  report ""
  report '```'
  cat "$body_file" >>"$REPORT"
  report ""
  report '```'
  report "</details>"
  report ""
  rm -f "$body_file"
  if [[ "$code" == "403" ]]; then
    record_auto 3 PASS "HTTP ${code} (CSRF middleware rejected the bare POST)"
  else
    record_auto 3 FAIL "expected 403, got ${code}"
  fi
}
run_if_ge 3 step3

# ---------------------------------------------------------------------------
# Steps 4-9 — Playwright browser session (single invocation)
# ---------------------------------------------------------------------------
run_browser_primary() {
  say "── Steps 4-9: Playwright browser session ──"
  inst "Launching headless Chromium to drive login → submit → pupil flow."
  inst "Per-step verdicts and any failure screenshots are recorded automatically."
  if APP_URL="$APP_URL" \
     HTG_TEACHER_USER="$HTG_TEACHER_USER" \
     HTG_TEACHER_PW="$HTG_TEACHER_PW" \
     HTG_PUPIL_USER="$HTG_PUPIL_USER" \
     HTG_PUPIL_PW="$HTG_PUPIL_PW" \
     PHASE0_OUT="$BROWSER_OUT_PRIMARY" \
     PHASE0_SCREENSHOTS="$SCREENSHOT_DIR" \
     PHASE0_STORAGE="$STORAGE_PATH" \
     PHASE0_PHASE=primary \
     run_capture "Playwright primary phase" npx --no -- tsx scripts/phase0-browser.ts; then
    ok "Browser script exited 0"
  else
    warn "Browser script exited non-zero — see per-step verdicts below."
  fi
}

step_browser_one() {
  local n="$1" title="$2"
  step_header "$n" "$title"
  if [[ ! -f "$BROWSER_OUT_PRIMARY" ]]; then
    record_auto "$n" FAIL "browser result JSON not found at $BROWSER_OUT_PRIMARY"
    return
  fi
  local status notes screenshot
  status=$(browser_step_field "$BROWSER_OUT_PRIMARY" "$n" status)
  notes=$(browser_step_field "$BROWSER_OUT_PRIMARY" "$n" notes)
  screenshot=$(browser_step_field "$BROWSER_OUT_PRIMARY" "$n" screenshot)
  if [[ -n "$screenshot" ]]; then
    report "- screenshot: \`${screenshot#${ROOT_DIR}/}\`"
    report ""
  fi
  case "$status" in
    pass) record_auto "$n" PASS "$notes" ;;
    fail) record_auto "$n" FAIL "$notes" ;;
    *)    record_auto "$n" FAIL "no result reported by browser script (status='${status}')" ;;
  esac
}

if (( START_STEP <= 9 )); then
  run_browser_primary
fi

run_if_ge 4 step_browser_one 4 "Bad password → flash + stays on /login"
run_if_ge 5 step_browser_one 5 "Good teacher login → /q/1"
run_if_ge 6 step_browser_one 6 "Question card content (badges, stem, part)"
run_if_ge 7 step_browser_one 7 "Teacher submits an answer (?saved=N + cleared textarea)"
run_if_ge 8 step_browser_one 8 "Pupil context — fresh form, no teacher answer leak"
run_if_ge 9 step_browser_one 9 "Pupil submits — distinct attempt id"

# DB-side cross-check for step 7/9: confirm the audit + attempt rows are
# actually present (browser only sees the redirect; this is the data-side
# check that used to be a separate step).
audit_xcheck() {
  step_header "7+9.db" "DB cross-check: attempts + audit since browser session began"
  local since
  since=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('${BROWSER_OUT_PRIMARY}','utf8')).startedAt||'')" 2>/dev/null)
  if [[ -z "$since" ]]; then
    record_auto "7+9.db" SKIP "browser startedAt timestamp not available"
    return
  fi
  psql_capture "submissions since ${since}" \
    "SELECT a.id, u.username, a.submitted_at, ap.raw_answer
       FROM attempts a
       JOIN users u             ON u.id = a.user_id
       JOIN attempt_questions aq ON aq.attempt_id = a.id
       JOIN attempt_parts ap     ON ap.attempt_question_id = aq.id
      WHERE a.submitted_at >= timestamptz '${since}'
      ORDER BY a.id DESC LIMIT 10;"
  local n_audit
  n_audit=$(audit_count_since "attempt.submitted" "$since")
  if [[ "${n_audit:-0}" -ge 2 ]]; then
    record_auto "7+9.db" PASS "${n_audit} attempt.submitted audit rows since ${since}"
  else
    record_auto "7+9.db" FAIL "expected ≥2 attempt.submitted audit rows, got ${n_audit:-0}"
  fi
}
run_if_ge 9 audit_xcheck

# ---------------------------------------------------------------------------
# Steps 10, 11 — fully automated HTTP checks
# ---------------------------------------------------------------------------
step10() {
  step_header 10 "Anonymous /q/1 redirects to /login"
  run_capture "curl -sI ${APP_URL}/q/1" curl -sI --max-time 5 "${APP_URL}/q/1"
  local loc
  loc=$(curl -sI --max-time 5 "${APP_URL}/q/1" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
  if [[ "${loc:-}" == */login* ]]; then
    record_auto 10 PASS "Location: ${loc}"
  else
    record_auto 10 FAIL "expected /login redirect, got '${loc:-<none>}'"
  fi
}
run_if_ge 10 step10

step11() {
  step_header 11 "/healthz returns { ok: true }"
  run_capture "curl ${APP_URL}/healthz" curl -sS --max-time 5 "${APP_URL}/healthz"
  local body
  body=$(curl -sS --max-time 5 "${APP_URL}/healthz" || echo "")
  if [[ "$body" == '{"ok":true}' ]]; then
    record_auto 11 PASS 'exact JSON {"ok":true}'
  else
    record_auto 11 FAIL "body was: ${body}"
  fi
}
run_if_ge 11 step11

# ---------------------------------------------------------------------------
# Steps 12-15 — reboot survival (one human prompt per dev-server transition)
# ---------------------------------------------------------------------------
step12() {
  step_header 12 "Count attempts before reboot"
  local n; n=$(psql_scalar "SELECT count(*) FROM attempts;")
  export PRE_REBOOT_ATTEMPTS="${n:-0}"
  report "- \`attempts\` count before reboot: **${PRE_REBOOT_ATTEMPTS}**"
  if [[ "${PRE_REBOOT_ATTEMPTS}" -ge 2 ]]; then
    record_auto 12 PASS "baseline ${PRE_REBOOT_ATTEMPTS} (≥2: teacher + pupil)"
  else
    record_auto 12 FAIL "baseline only ${PRE_REBOOT_ATTEMPTS} — steps 7/9 may not have landed"
  fi
}
run_if_ge 12 step12

step13() {
  step_header 13 "Stop dev server, then DB container"
  inst "In your dev-server terminal, press Ctrl-C to stop 'npm run dev'."
  pause_for_human "Once the dev server has stopped"
  if run_capture "npm run db:down" npm run --silent db:down; then
    record_auto 13 PASS "DB container stopped"
  else
    record_auto 13 FAIL "npm run db:down exited non-zero"
  fi
}
run_if_ge 13 step13

step14() {
  step_header 14 "Restart DB + migrations + dev server"
  run_capture "npm run db:up" npm run --silent db:up
  inst "Waiting 4s for Postgres to accept connections..."
  sleep 4
  local migrate_out; migrate_out=$(mktemp)
  npm run --silent db:migrate >"$migrate_out" 2>&1
  local migrate_rc=$?
  cat "$migrate_out" | sed 's/^/    /'
  report "<details><summary>npm run db:migrate (exit ${migrate_rc})</summary>"
  report ""; report '```'; cat "$migrate_out" >>"$REPORT"; report '```'; report "</details>"; report ""
  local pending_ok=0
  if grep -qiE 'no pending migrations|0 pending' "$migrate_out"; then pending_ok=1; fi
  rm -f "$migrate_out"

  inst "Now restart your dev server: 'npm run dev'"
  pause_for_human "When you see 'Server listening on 0.0.0.0:3030'"

  local server_ok=0
  if curl -fsS --max-time 4 "${APP_URL}/healthz" >/dev/null 2>&1; then server_ok=1; fi

  if (( migrate_rc == 0 && pending_ok == 1 && server_ok == 1 )); then
    record_auto 14 PASS "migrate=0 pending, dev server reachable"
  else
    record_auto 14 FAIL "migrate_rc=${migrate_rc}, no_pending_msg=${pending_ok}, healthz_ok=${server_ok}"
  fi
}
run_if_ge 14 step14

step15() {
  step_header 15 "Re-count attempts — data survived reboot"
  local n; n=$(psql_scalar "SELECT count(*) FROM attempts;")
  report "- before: **${PRE_REBOOT_ATTEMPTS:-?}**, after: **${n:-?}**"
  if [[ "${n:-X}" == "${PRE_REBOOT_ATTEMPTS:-Y}" ]]; then
    record_auto 15 PASS "counts match (${n})"
  else
    record_auto 15 FAIL "before=${PRE_REBOOT_ATTEMPTS:-?} after=${n:-?} — data did NOT survive"
  fi
}
run_if_ge 15 step15

# ---------------------------------------------------------------------------
# Step 16 — Playwright post-reboot session check
# ---------------------------------------------------------------------------
step16() {
  step_header 16 "Saved teacher session — /q/1 either renders or redirects to /login"
  if [[ ! -f "$STORAGE_PATH" ]]; then
    record_auto 16 SKIP "no saved storage state at ${STORAGE_PATH} (steps 4-9 did not run)"
    return
  fi
  if APP_URL="$APP_URL" \
     HTG_TEACHER_USER="$HTG_TEACHER_USER" \
     HTG_TEACHER_PW="$HTG_TEACHER_PW" \
     HTG_PUPIL_USER="$HTG_PUPIL_USER" \
     HTG_PUPIL_PW="$HTG_PUPIL_PW" \
     PHASE0_OUT="$BROWSER_OUT_REBOOT" \
     PHASE0_SCREENSHOTS="$SCREENSHOT_DIR" \
     PHASE0_STORAGE="$STORAGE_PATH" \
     PHASE0_PHASE=post-reboot \
     run_capture "Playwright post-reboot phase" npx --no -- tsx scripts/phase0-browser.ts; then
    :
  fi
  local status notes screenshot
  status=$(browser_step_field "$BROWSER_OUT_REBOOT" 16 status)
  notes=$(browser_step_field "$BROWSER_OUT_REBOOT" 16 notes)
  screenshot=$(browser_step_field "$BROWSER_OUT_REBOOT" 16 screenshot)
  if [[ -n "$screenshot" ]]; then
    report "- screenshot: \`${screenshot#${ROOT_DIR}/}\`"
    report ""
  fi
  case "$status" in
    pass) record_auto 16 PASS "$notes" ;;
    fail) record_auto 16 FAIL "$notes" ;;
    *)    record_auto 16 FAIL "no result reported (status='${status}')" ;;
  esac
}
run_if_ge 16 step16

# ---------------------------------------------------------------------------
# Step 17 — Backup file written
# ---------------------------------------------------------------------------
step17() {
  step_header 17 "npm run db:backup writes .dump + .sha256"
  local before_count
  before_count=$(find ./tmp/backups -maxdepth 1 -name 'exam_dev-*.dump' 2>/dev/null | wc -l)
  if ! run_capture "npm run db:backup" npm run --silent db:backup; then
    record_auto 17 FAIL "npm run db:backup exited non-zero"
    return
  fi
  run_capture "ls ./tmp/backups" bash -c 'ls -lh ./tmp/backups 2>/dev/null | tail -n 10 || echo "no backups dir"'
  local after_count
  after_count=$(find ./tmp/backups -maxdepth 1 -name 'exam_dev-*.dump' 2>/dev/null | wc -l)
  local newest_dump
  newest_dump=$(find ./tmp/backups -maxdepth 1 -name 'exam_dev-*.dump' -printf '%T@ %p\n' 2>/dev/null \
                  | sort -nr | head -1 | awk '{print $2}')
  if (( after_count > before_count )) && [[ -f "${newest_dump%.dump}.sha256" ]]; then
    record_auto 17 PASS "new dump $(basename "$newest_dump") + sibling .sha256"
  else
    record_auto 17 FAIL "no new dump (before=${before_count}, after=${after_count}) or missing .sha256 sibling"
  fi
}
run_if_ge 17 step17

# ---------------------------------------------------------------------------
# Step 18 — Restore drill
# ---------------------------------------------------------------------------
step18() {
  step_header 18 "npm run db:restore-drill"
  local out; out=$(mktemp)
  npm run --silent db:restore-drill >"$out" 2>&1
  local rc=$?
  cat "$out" | sed 's/^/    /'
  report "<details><summary>npm run db:restore-drill (exit ${rc})</summary>"
  report ""; report '```'; cat "$out" >>"$REPORT"; report '```'; report "</details>"; report ""
  local pass_line
  pass_line=$(grep -E '\[restore-drill\] PASS:' "$out" | head -n1 || true)
  rm -f "$out"
  if (( rc == 0 )) && [[ -n "$pass_line" ]]; then
    record_auto 18 PASS "$(echo "$pass_line" | sed 's/^\[restore-drill\] //')"
  else
    record_auto 18 FAIL "rc=${rc}, pass_line='${pass_line}'"
  fi
}
run_if_ge 18 step18

# ---------------------------------------------------------------------------
# Step 19 — RUNBOOK.md entry (human only — there is no scriptable check
# that you put the right initials and phrasing into the runbook)
# ---------------------------------------------------------------------------
step19() {
  step_header 19 "Record the run in RUNBOOK.md §10"
  inst "Add ONE line to RUNBOOK.md §10 (the suggested line is in the report's Summary)."
  ask_pf "Entry added to RUNBOOK.md?" 19
}
run_if_ge 19 step19
