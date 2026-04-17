#!/usr/bin/env bash
# Phase 1 sign-off walker, automated end-to-end.
#
# Mirrors scripts/human-test-phase0.sh. Automates the Phase 1 happy path
# from HUMAN_TEST_GUIDE.md §Phase 1 walker:
#   - preflight: DB up, migrations, seeder idempotency, fixture users
#   - HTTP-only anonymous checks (steps 1-3) → curl + assert, no prompt
#   - Playwright browser session (steps 4-19):
#       * teacher: login, create class, enrol pupil, assign topic,
#                  author a new question via the admin UI, approve it
#       * pupil:   login, pick topic, partial save, close+re-login,
#                  verify resume, submit, see review page
#       * teacher: open submissions, override a mark, flash confirms
#       * pupil:   reload review, score reflects override
#   - DB cross-checks (step 20): audit_events + awarded_marks
#
# A timestamped markdown report lands at
# tmp/human-tests/phase1-<utc-ts>.md with every captured stdout/stderr,
# every verdict (auto or human), and links to any Playwright failure
# screenshots.
#
# Usage:
#   npm run test:human:phase1
#   bash scripts/human-test-phase1.sh --step 12       # resume from step 12
#   bash scripts/human-test-phase1.sh --no-preflight  # skip preflight
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
REPORT="${REPORT_DIR}/phase1-${TS}.md"
SCREENSHOT_DIR="${REPORT_DIR}/phase1-${TS}-screenshots"
BROWSER_OUT="${REPORT_DIR}/phase1-${TS}-browser.json"
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

# Phase 1 uses its own fixture users so a Phase 0 run next door does not
# disturb state. Class name is dated so re-runs on consecutive days are
# unique; same-day re-runs reuse the existing class (the walker tolerates
# the 409 and picks the existing row).
PHASE1_TEACHER_USER="p1_teacher"
PHASE1_TEACHER_PW="p1-teacher-pw-1"
PHASE1_PUPIL_USER="p1_pupil"
PHASE1_PUPIL_PW="p1-pupil-pw-1"
PHASE1_CLASS_NAME="Phase1 Walker $(date -u +%Y-%m-%d)"
PHASE1_ACADEMIC_YEAR="2025-26"
PHASE1_TOPIC_CODE="1.2"
PHASE1_AUTHOR_STEM="Phase 1 walker — auto-authored question on a CPU component (ignore in exam prep)."

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
say()    { printf '\n%s%s%s\n' "$C_CYAN$C_BOLD" "$*" "$C_RESET"; }
inst()   { printf '  %s\n' "$*"; }
hint()   { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()     { printf '  %s✓ %s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn()   { printf '  %s! %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
err()    { printf '  %s✗ %s%s\n' "$C_RED" "$*" "$C_RESET"; }

step_header() {
  local n="$1"; shift
  local title="$*"
  say "── Step ${n}: ${title} ──"
  report ""
  report "## Step ${n} — ${title}"
  report ""
}

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

psql_capture() {
  local label="$1" sql="$2"
  run_capture "$label" docker compose exec -T postgres psql -U exam -d exam_dev -XAt -c "$sql"
}

psql_scalar() {
  local sql="$1"
  docker compose exec -T postgres psql -U exam -d exam_dev -XAt -c "$sql" 2>/dev/null | head -n1
}

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

browser_top_field() {
  local json="$1" field="$2"
  node -e "
    const fs=require('node:fs');
    const d=JSON.parse(fs.readFileSync('${json}','utf8'));
    process.stdout.write(String(d.${field}||''));
  " 2>/dev/null
}

audit_count_since() {
  local ev="$1" since="$2"
  psql_scalar "SELECT count(*) FROM audit_events WHERE event_type='${ev}' AND at >= timestamptz '${since}';"
}

run_if_ge() { local want="$1"; shift; (( START_STEP <= want )) && "$@"; }

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
    report "**Overall: PASS** — safe to sign off Phase 1 in RUNBOOK.md §10."
    report ""
    report "Suggested RUNBOOK.md §10 line:"
    report ""
    report "    ${TS} — <initials> — Phase 1 human test — PASS (report: ${REPORT#${ROOT_DIR}/})"
  else
    report "**Overall: NOT PASS** — do not sign off Phase 1 until the failed/skipped steps are resolved."
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

report "# Phase 1 human test — ${TS}"
report ""
report "- Project: exam_questions (OCR J277 revision platform)"
report "- Run by: $(id -un 2>/dev/null || echo unknown)@$(hostname -s 2>/dev/null || echo unknown)"
report "- Script: scripts/human-test-phase1.sh"
report "- Browser driver: scripts/phase1-browser.ts (Playwright/Chromium, headless)"
report "- Maps to: [HUMAN_TEST_GUIDE.md](../../HUMAN_TEST_GUIDE.md) §Phase 1"
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

  inst "Seeding curated content (npm run content:seed). This is idempotent."
  if run_capture "npm run content:seed" npm run --silent content:seed; then
    ok "content:seed completed"
  else
    # The seeder does DELETE+INSERT on question_parts, which FK-violates if a
    # prior walker run created attempt_parts against those rows. That is
    # benign: the curated content is already present for the topic under
    # test. Verify directly from the DB and only bail if the topic lacks
    # enough approved questions for a topic set.
    warn "content:seed reported failures — verifying curated content for topic ${PHASE1_TOPIC_CODE} is present in the DB."
    curated_count="$(psql_scalar "SELECT count(*) FROM questions WHERE topic_code = '${PHASE1_TOPIC_CODE}' AND approval_status = 'approved' AND active = true")"
    if [[ -n "$curated_count" && "$curated_count" -ge 5 ]]; then
      ok "topic ${PHASE1_TOPIC_CODE} already has ${curated_count} approved+active questions — continuing."
      report "- content:seed: tolerated FK errors (topic ${PHASE1_TOPIC_CODE} already has ${curated_count} approved+active questions)"
    else
      err "content:seed failed and topic ${PHASE1_TOPIC_CODE} has only ${curated_count:-0} approved questions — stop here."
      exit 2
    fi
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

  inst "Creating Phase 1 fixture users ${PHASE1_TEACHER_USER} and ${PHASE1_PUPIL_USER} (idempotent)..."
  run_capture "create ${PHASE1_TEACHER_USER}" \
    npm run --silent user:create -- \
      --role teacher --username "$PHASE1_TEACHER_USER" \
      --display-name "Phase1 Teacher" --pseudonym TEA-P1-01 \
      --password "$PHASE1_TEACHER_PW"
  run_capture "create ${PHASE1_PUPIL_USER}" \
    npm run --silent user:create -- \
      --role pupil --username "$PHASE1_PUPIL_USER" \
      --display-name "Phase1 Pupil" --pseudonym PUP-P1-01 \
      --password "$PHASE1_PUPIL_PW"
fi

# Record baselines that a later DB cross-check compares against.
BASELINE_OVERRIDE_COUNT="$(psql_scalar "SELECT count(*) FROM audit_events WHERE event_type='marking.override';")"
BASELINE_OVERRIDE_COUNT="${BASELINE_OVERRIDE_COUNT:-0}"
BASELINE_ATTEMPTS="$(psql_scalar 'SELECT count(*) FROM attempts;')"
BASELINE_ATTEMPTS="${BASELINE_ATTEMPTS:-0}"
report ""
report "Baseline \`audit_events(marking.override)\` count: **${BASELINE_OVERRIDE_COUNT}**"
report "Baseline \`attempts\` count: **${BASELINE_ATTEMPTS}**"
report ""

# ---------------------------------------------------------------------------
# Steps 1, 2, 3 — fully automated HTTP checks (no human prompt)
# ---------------------------------------------------------------------------
step1() {
  step_header 1 "Anonymous /admin/classes redirects to /login"
  run_capture "curl -sI ${APP_URL}/admin/classes" curl -sI --max-time 5 "${APP_URL}/admin/classes"
  local loc
  loc=$(curl -sI --max-time 5 "${APP_URL}/admin/classes" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
  if [[ "${loc:-}" == */login* ]]; then
    record_auto 1 PASS "Location: ${loc}"
  else
    record_auto 1 FAIL "expected redirect to /login, got '${loc:-<none>}'"
  fi
}
run_if_ge 1 step1

step2() {
  step_header 2 "Anonymous /topics redirects to /login"
  run_capture "curl -sI ${APP_URL}/topics" curl -sI --max-time 5 "${APP_URL}/topics"
  local loc
  loc=$(curl -sI --max-time 5 "${APP_URL}/topics" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')
  if [[ "${loc:-}" == */login* ]]; then
    record_auto 2 PASS "Location: ${loc}"
  else
    record_auto 2 FAIL "expected redirect to /login, got '${loc:-<none>}'"
  fi
}
run_if_ge 2 step2

step3() {
  step_header 3 "POST /admin/classes without CSRF is rejected (403)"
  local body_file; body_file="$(mktemp)"
  local code
  code=$(curl -s -o "$body_file" -w '%{http_code}' \
           --max-time 5 \
           -X POST \
           -H 'content-type: application/x-www-form-urlencoded' \
           --data 'name=foo&academic_year=2025-26' \
           "${APP_URL}/admin/classes" || echo "000")
  report "<details><summary>response body</summary>"
  report ""
  report '```'
  cat "$body_file" >>"$REPORT"
  report ""
  report '```'
  report "</details>"
  report ""
  rm -f "$body_file"
  # The CSRF middleware returns 403 before any auth check runs.
  if [[ "$code" == "403" ]]; then
    record_auto 3 PASS "HTTP ${code} (CSRF middleware rejected the bare POST)"
  else
    record_auto 3 FAIL "expected 403, got ${code}"
  fi
}
run_if_ge 3 step3

# ---------------------------------------------------------------------------
# Steps 4-19 — Playwright browser session (single invocation)
# ---------------------------------------------------------------------------
run_browser_primary() {
  say "── Steps 4-19: Playwright browser session ──"
  inst "Launching headless Chromium to drive teacher + pupil + override flows."
  inst "Per-step verdicts and any failure screenshots are recorded automatically."
  if APP_URL="$APP_URL" \
     PHASE1_TEACHER_USER="$PHASE1_TEACHER_USER" \
     PHASE1_TEACHER_PW="$PHASE1_TEACHER_PW" \
     PHASE1_PUPIL_USER="$PHASE1_PUPIL_USER" \
     PHASE1_PUPIL_PW="$PHASE1_PUPIL_PW" \
     PHASE1_CLASS_NAME="$PHASE1_CLASS_NAME" \
     PHASE1_ACADEMIC_YEAR="$PHASE1_ACADEMIC_YEAR" \
     PHASE1_TOPIC_CODE="$PHASE1_TOPIC_CODE" \
     PHASE1_AUTHOR_STEM="$PHASE1_AUTHOR_STEM" \
     PHASE1_OUT="$BROWSER_OUT" \
     PHASE1_SCREENSHOTS="$SCREENSHOT_DIR" \
     run_capture "Playwright Phase 1 session" npx --no -- tsx scripts/phase1-browser.ts; then
    ok "Browser script exited 0"
  else
    warn "Browser script exited non-zero — see per-step verdicts below."
  fi
}

step_browser_one() {
  local n="$1" title="$2"
  step_header "$n" "$title"
  if [[ ! -f "$BROWSER_OUT" ]]; then
    record_auto "$n" FAIL "browser result JSON not found at $BROWSER_OUT"
    return
  fi
  local status notes screenshot
  status=$(browser_step_field "$BROWSER_OUT" "$n" status)
  notes=$(browser_step_field "$BROWSER_OUT" "$n" notes)
  screenshot=$(browser_step_field "$BROWSER_OUT" "$n" screenshot)
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

if (( START_STEP <= 19 )); then
  run_browser_primary
fi

run_if_ge 4  step_browser_one 4  "Teacher logs in"
run_if_ge 5  step_browser_one 5  "Teacher creates (or reuses) a class"
run_if_ge 6  step_browser_one 6  "Teacher enrols the Phase 1 pupil"
run_if_ge 7  step_browser_one 7  "Teacher assigns the Phase 1 topic"
run_if_ge 8  step_browser_one 8  "Authoring form renders at /admin/questions/new"
run_if_ge 9  step_browser_one 9  "Teacher authors + submits a new question"
run_if_ge 10 step_browser_one 10 "Teacher approves the authored question"
run_if_ge 11 step_browser_one 11 "Authored question appears in /admin/questions list"
run_if_ge 12 step_browser_one 12 "Pupil logs in and sees the assigned topic"
run_if_ge 13 step_browser_one 13 "Pupil starts the topic set → /attempts/<id>"
run_if_ge 14 step_browser_one 14 "Pupil saves partial progress (first part only)"
run_if_ge 15 step_browser_one 15 "Partial answer survives logout + re-login"
run_if_ge 16 step_browser_one 16 "Pupil fills remaining parts and submits"
run_if_ge 17 step_browser_one 17 "Teacher sees submission on /admin/classes/:id/attempts"
run_if_ge 18 step_browser_one 18 "Teacher overrides a mark with reason"
run_if_ge 19 step_browser_one 19 "Pupil review page reflects the override"

# ---------------------------------------------------------------------------
# Step 20 — DB cross-checks
# ---------------------------------------------------------------------------
step20() {
  step_header 20 "DB cross-check: audit + awarded_marks landed"
  local since
  since=$(browser_top_field "$BROWSER_OUT" startedAt)
  local attempt_id part_id class_id
  attempt_id=$(browser_top_field "$BROWSER_OUT" attemptId)
  part_id=$(browser_top_field "$BROWSER_OUT" firstPartId)
  class_id=$(browser_top_field "$BROWSER_OUT" classId)

  report "- browser-reported: class_id=${class_id:-?}, attempt_id=${attempt_id:-?}, first_part_id=${part_id:-?}, startedAt=${since:-?}"
  report ""

  if [[ -z "$since" ]]; then
    record_auto 20 SKIP "browser startedAt timestamp not available; nothing to cross-check"
    return
  fi

  # Audit row counts since the walker started.
  local started submitted saved override enrol_added class_created topic_assigned q_created
  started=$(audit_count_since "attempt.started"      "$since")
  submitted=$(audit_count_since "attempt.submitted"  "$since")
  saved=$(audit_count_since    "attempt.part.saved"  "$since")
  override=$(audit_count_since "marking.override"    "$since")
  enrol_added=$(audit_count_since "enrolment.added"  "$since")
  class_created=$(audit_count_since "class.created"  "$since")
  topic_assigned=$(audit_count_since "class.topic_assigned" "$since")
  q_created=$(audit_count_since "question.created"   "$since")

  psql_capture "audit_events since ${since}" \
    "SELECT event_type, count(*) FROM audit_events WHERE at >= timestamptz '${since}' GROUP BY 1 ORDER BY 1;"

  local fails=()
  (( ${started:-0}       >= 1 )) || fails+=("attempt.started<1 (${started:-0})")
  (( ${submitted:-0}     >= 1 )) || fails+=("attempt.submitted<1 (${submitted:-0})")
  (( ${saved:-0}         >= 1 )) || fails+=("attempt.part.saved<1 (${saved:-0})")
  (( ${override:-0}      >= 1 )) || fails+=("marking.override<1 (${override:-0})")
  (( ${q_created:-0}     >= 1 )) || fails+=("question.created<1 (${q_created:-0})")
  # enrolment.added and class.topic_assigned and class.created can be 0 on a
  # repeat run (same-day) because the walker tolerates idempotent enrolment,
  # topic re-assignment, and class reuse. We still emit them for the record.
  report "- enrolment.added (may be 0 on repeat runs): ${enrol_added:-0}"
  report "- class.created (may be 0 on repeat runs): ${class_created:-0}"
  report "- class.topic_assigned (may be 0 on repeat runs): ${topic_assigned:-0}"

  # awarded_marks row for the overridden part.
  if [[ -n "$part_id" ]]; then
    psql_capture "awarded_marks for attempt_part_id=${part_id}" \
      "SELECT id, marker, marks_awarded, marks_total, created_at
         FROM awarded_marks
        WHERE attempt_part_id = ${part_id}
        ORDER BY created_at DESC;"
    local override_rows
    override_rows=$(psql_scalar \
      "SELECT count(*) FROM awarded_marks WHERE attempt_part_id = ${part_id} AND marker = 'teacher_override';")
    if (( ${override_rows:-0} >= 1 )); then
      :
    else
      fails+=("no teacher_override awarded_marks row for part ${part_id} (${override_rows:-0})")
    fi
  else
    fails+=("no first_part_id from browser — cannot verify awarded_marks override")
  fi

  if (( ${#fails[@]} == 0 )); then
    record_auto 20 PASS "audit + awarded_marks consistent with walker expectations"
  else
    record_auto 20 FAIL "$(IFS='; '; echo "${fails[*]}")"
  fi
}
run_if_ge 20 step20

# ---------------------------------------------------------------------------
# Step 21 — RUNBOOK.md entry (human only)
# ---------------------------------------------------------------------------
step21() {
  step_header 21 "Record the run in RUNBOOK.md §10"
  inst "Add ONE line to RUNBOOK.md §10 (the suggested line is in the report's Summary)."
  ask_pf "Entry added to RUNBOOK.md?" 21
}
run_if_ge 21 step21
