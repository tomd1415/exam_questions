# Operations runbook

> **Status: Phase 0 draft.** Covers what Phase 0 must document
> (firewall, TLS, restart, restore, key rotation). The full
> operational runbook is a Phase 7 deliverable per
> [PLAN.md](PLAN.md); update this file as new operational
> procedures are introduced.
>
> **Audience:** the project owner (single admin). Steps assume
> root or `sudo` on the Debian VM unless stated.

## 1. Topology

```text
[ pupil device on school LAN ] --HTTPS:443--> [ revision.<school>.internal ]
                                                  │
                                       Debian VM (Proxmox)
                                       ├── nginx / Caddy (TLS termination)
                                       ├── Node.js app (systemd: exam-questions.service)
                                       └── PostgreSQL 16 + pgvector
                                                  │
                              outbound HTTPS:443 ──┴──> api.openai.com  (Phase 3+, gated by LLM_ENABLED)
```

- Single VM hosts app + database for the MVP.
- LAN-only. No public ingress. Home access is out of scope until the home-access decision is revisited (see [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) §3).
- Proxmox snapshots are an additional rollback tool; they do **not** replace the DB-level backup drill in §6.

## 2. Firewall rules

Captured here as the source of truth. School-side firewall is configured by the project owner.

| Direction | Source               | Destination                  | Port | Protocol | Purpose                                      |
| --------- | -------------------- | ---------------------------- | ---- | -------- | -------------------------------------------- |
| Inbound   | School pupil VLAN(s) | `revision.<school>.internal` | 443  | TCP      | Pupils reach the app                         |
| Inbound   | Admin workstation(s) | VM                           | 22   | TCP      | SSH for admin (key-only, password disabled)  |
| Outbound  | VM                   | School DNS resolvers         | 53   | TCP/UDP  | Name resolution                              |
| Outbound  | VM                   | Debian + npm package mirrors | 443  | TCP      | OS / dependency updates                      |
| Outbound  | VM                   | School NTP server            | 123  | UDP      | Time sync (TLS + cookie expiry depend on it) |
| Outbound  | VM                   | `api.openai.com`             | 443  | TCP      | Phase 3+ only, gated by `LLM_ENABLED=true`   |

Any other outbound destination from the VM should be considered an anomaly. Default-deny is preferred; allow-list the rows above.

## 3. TLS

Two options, decide one and record the choice here once installed:

**Option A — School internal CA (preferred for LAN-only).**
Generate a CSR on the VM, hand to school IT, install the issued cert at `/etc/ssl/exam-questions/fullchain.pem` and key at `/etc/ssl/exam-questions/privkey.pem` (mode `0600`, owner `root:root`). No external dependencies, but the school CA must be trusted by pupil devices already.

**Option B — Let's Encrypt via DNS-01.**
Used only if the subdomain has public DNS. Avoids HTTP-01 (no public ingress is needed). Cert renewal is automatic via the ACME client (e.g. `acme.sh` or `certbot --preferred-challenges dns`). Renewal hook reloads nginx/Caddy.

Either way:

- Cert + key files **never** leave the VM.
- TLS 1.2 minimum; prefer 1.3.
- HSTS enabled with a short `max-age` (300s) until the cert pipeline is proven, then bump to 6 months.

**Decision:** _<fill in the chosen option, install date, expiry date, renewal mechanism>_

## 4. Process management

The Node.js app runs under systemd. Suggested unit (install at `/etc/systemd/system/exam-questions.service`):

```ini
[Unit]
Description=Exam Questions (J277 revision)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=exam
Group=exam
WorkingDirectory=/opt/exam-questions/current
EnvironmentFile=/etc/exam-questions/env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/log/exam-questions

[Install]
WantedBy=multi-user.target
```

Common operations:

```bash
# Status
systemctl status exam-questions

# Restart (graceful — app handles SIGTERM)
sudo systemctl restart exam-questions

# Tail logs
journalctl -u exam-questions -f

# Edit env then reload (env is read at process start)
sudo -e /etc/exam-questions/env && sudo systemctl restart exam-questions
```

Postgres runs as the distro service (`systemctl status postgresql`).

## 5. Routine restart / deployment

Phase 0 deploys are manual. A deploy is: pull the new build artefacts into a new release directory, switch the `current` symlink, run migrations, restart.

```bash
# On the VM, as the deploy user
cd /opt/exam-questions
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)
mkdir releases/$RELEASE
# (copy the built artefact into releases/$RELEASE — exact mechanism TBD in Phase 1)

# Apply migrations BEFORE switching the symlink
cd releases/$RELEASE
npm run db:migrate

# Atomic switch
ln -sfn releases/$RELEASE /opt/exam-questions/current
sudo systemctl restart exam-questions

# Smoke check
curl -sf https://revision.<school>.internal/healthz
```

Roll back: re-point `current` at the previous release directory and `systemctl restart exam-questions`. Migrations are forward-only — a rollback that requires a schema change is a restore-from-backup operation (§6).

### 5.1 Resetting question content (dev / test-only)

Only relevant while the DB contains throwaway test content — both the Gentoo dev box and the school LAN VM during the pre-launch phase. **Do not run this on a tenant that is holding pupil submissions worth keeping.**

```bash
# Wipe attempts + drafts + questions, then reseed from content/curated/
npm run content:reset -- --yes

# Wipe only, skip reseed (leaves the questions table empty)
npm run content:reset -- --yes --no-seed

# Custom curated folder
npm run content:reset -- --yes --dir path/to/content
```

Internals: [src/scripts/reset-questions.ts](src/scripts/reset-questions.ts) runs three deletes in a single transaction, relying on the FK cascade rules in [migrations/0005_attempts.sql](migrations/0005_attempts.sql): `attempts` cascades to `attempt_questions` and `attempt_question_parts`; `questions` cascades to `question_parts`, `question_mark_points`, and `question_misconceptions`. `question_drafts.published_question_id` is `ON DELETE SET NULL`, so drafts survive but their `published_question_id` clears — which is why drafts are deleted in the same transaction.

The first pre-launch use was 2026-04-19 to pick up the chunk-B2 model-answer shape fix; on a tenant with real submissions this path would instead be a surgical `DELETE FROM attempts WHERE ...` scoped to the affected class.

### 5.2 Seeding widget test questions (dev only)

For hand-testing every widget variant end-to-end without polluting the random-draw pool that real pupils use:

```bash
# Create test_pupil + test_teacher + Widget Test Harness class,
# seed 2 questions per response type (34 total), AND attach every
# live curated question (approved + active + retired_at IS NULL)
# to the same pre-loaded topic-set attempt owned by test_pupil.
npm run test-questions:seed

# Validate all 34 internal fixtures without writing anything
# (dry-run skips the curated attachment step).
npm run test-questions:seed -- --dry-run

# Purge previous 'test:%' questions (and attempts that reference them)
# before re-seeding.
npm run test-questions:seed -- --reset
```

The 34 internal widget fixtures are marked `active=false + approval_status=approved`, so `createTopicSetAttempt` never draws them for other classes; the pupil just continues the pre-built attempt. Curated questions are `active=true` and so are also visible to real classes via the normal picker — they are attached here so the test pupil always exercises the current curated bank. Sign in as `test_pupil` (password printed on first run) and work through each question in order.

The output line reports both counts, e.g. `pre-loaded attempt 29 with 56 questions (34 widget fixtures + 22 curated)`.

Internals: [src/scripts/seed-test-questions.ts](src/scripts/seed-test-questions.ts). Similarity hashes are `test:<type>-<n>` for fixtures and `curated:<external_key>` for curated rows; re-runs upsert rather than duplicate. If curated content has changed, run `npm run content:seed` first to refresh the bank, then `npm run test-questions:seed -- --reset` to rebuild the attempt.

## 6. Backup and restore drill

The school's existing backup regime captures the VM. **In addition**, this project requires a DB-level dump so that a restore can be exercised without the full VM-restore path.

### 6.1 Daily DB dump

A nightly cron / systemd timer runs [scripts/backup-db.sh](scripts/backup-db.sh). Output:

```text
/var/backups/exam-questions/exam_dev-YYYYMMDDTHHMMSSZ.dump   # custom-format pg_dump
/var/backups/exam-questions/exam_dev-YYYYMMDDTHHMMSSZ.sha256 # checksum
```

The school backup regime is configured to pick up `/var/backups/exam-questions/`.

### 6.2 Restore drill (Phase 0 sign-off and half-termly thereafter)

Run [scripts/restore-drill.sh](scripts/restore-drill.sh) against a scratch database. The script:

1. Creates a temporary database `exam_restore_drill_<ts>`.
2. Restores the most recent dump into it with `pg_restore`.
3. Runs verification queries (row counts on `users`, `questions`, `question_parts`, `audit_events`).
4. Drops the scratch database.
5. Prints a one-line PASS/FAIL summary.

Record each drill in §10 below.

**Phase 0 sign-off requires at least one PASS recorded in §10.**

On the dev machine the same scripts are wired up via npm (they delegate `pg_dump` / `pg_restore` to the dockerised Postgres so client-vs-server versions match):

```bash
npm run db:backup          # writes to ./tmp/backups/
npm run db:restore-drill   # restores most recent dump into a scratch DB and verifies
```

### 6.3 Manual restore into production

Only after declaring an incident. Always restore into a NEW database first and rename, never `pg_restore` over a live database.

```bash
DUMP=/var/backups/exam-questions/exam_dev-<ts>.dump
NEW=exam_restore_$(date -u +%Y%m%dT%H%M%SZ)

sudo -u postgres createdb "$NEW"
sudo -u postgres pg_restore --no-owner --role=exam --dbname "$NEW" "$DUMP"

# Verify
sudo -u postgres psql -d "$NEW" -c "SELECT count(*) FROM users; SELECT count(*) FROM audit_events;"

# Stop the app, swap, start
sudo systemctl stop exam-questions
sudo -u postgres psql -c "ALTER DATABASE exam_dev RENAME TO exam_dev_broken_$(date -u +%Y%m%dT%H%M%SZ);"
sudo -u postgres psql -c "ALTER DATABASE \"$NEW\" RENAME TO exam_dev;"
sudo systemctl start exam-questions
```

## 7. Key and secret rotation

| Secret                          | Where                                    | Cadence                | How to rotate                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                | `/etc/exam-questions/env`                | Termly, or on incident | Generate `openssl rand -hex 32`, edit env, `systemctl restart exam-questions`. **All existing sessions are invalidated** — schedule outside lesson hours.                                                           |
| Database password (`exam` role) | `/etc/exam-questions/env` `DATABASE_URL` | Termly                 | `ALTER ROLE exam WITH PASSWORD '<new>';` then update env, `systemctl restart exam-questions`.                                                                                                                       |
| TLS certificate                 | `/etc/ssl/exam-questions/`               | Per cert validity      | Install renewed cert + key, reload nginx/Caddy. Verify `openssl s_client` shows the new fingerprint and expiry.                                                                                                     |
| `OPENAI_API_KEY` (Phase 3+)     | `/etc/exam-questions/env`                | Termly                 | Mint a new dev-scoped key in the OpenAI dashboard with the same spending cap, edit env, `systemctl restart exam-questions`, then revoke the old key. Confirm `LLM_ENABLED=true` is still gated by the spending cap. |
| Pupil / teacher passwords       | `users.password_hash` in DB              | On compromise / leaver | Use `npm run user:create -- --username <u> --password <new> ...` (idempotent UPSERT). Set `must_change_password=true` so they're forced to change at next login. Audit the action via `audit_events`.               |
| SSH host keys                   | `/etc/ssh/`                              | Annually               | `ssh-keygen -A` after backing up the existing keys; notify yourself so the host-key change at next login is expected.                                                                                               |

Always record a rotation in §10 (one-line entry).

## 8. Incident-response quick reference

A fuller checklist is a Phase 3+ deliverable; this is the Phase 0 minimum.

1. **Suspected data leak / wrong-pupil-data exposure:** stop the app (`systemctl stop exam-questions`); preserve logs (`journalctl -u exam-questions --since '-2h' > /tmp/incident-$(date -u +%s).log`); inform DPO; do **not** delete `audit_events`.
2. **Suspected credential compromise:** rotate `SESSION_SECRET` and the affected user's password (§7). All sessions terminate.
3. **Suspected runaway LLM cost (Phase 3+):** set `LLM_ENABLED=false` in env, restart. Verify on the OpenAI dashboard that calls have stopped.
4. **Database corruption:** restore drill path (§6.3). Do not run schema changes on the broken DB.

## 9. Observability (Phase 0 minimum)

- App logs: `journalctl -u exam-questions`. Pino-pretty in dev, JSON in prod.
- Postgres logs: `journalctl -u postgresql` (or distro path).
- Healthcheck: `GET /healthz` returns `{ "ok": true }` — used by an internal cron / systemd timer for the "is it up at 8:50am?" alert.
- Audit trail: `audit_events` table is append-only and is the source of truth for "who did what". See [DATA_MODEL.md](DATA_MODEL.md).

Richer telemetry (Sentry, dashboards, prompt-cost tracking) is Phase 3+.

## 10. Operational log

Append-only. One line per significant operation. Keep it terse.

| Date (UTC) | Operator | Action                                                                                   | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-16 | TD       | First restore drill (`npm run db:restore-drill`, dev — drill reference for VM procedure) | PASS — 4 users, 1 question, 1 part, 42 audit events, 7 migrations restored into scratch DB; scratch DB dropped.                                                                                                                                                                                                                                                                                                                                      |
| 2026-04-16 | TD       | Phase 0 human test (`npm run test:human:phase0`)                                         | PASS — 20/20 steps; report: `tmp/human-tests/phase0-20260416T173722Z.md`. Satisfies Phase 0.E sign-off checklist.                                                                                                                                                                                                                                                                                                                                    |
| 2026-04-16 | TD       | DPIA first draft written ([DPIA.md](DPIA.md))                                            | DRAFT — awaiting DPO and safeguarding lead sign-off. No pupil data to be processed until both signatures land.                                                                                                                                                                                                                                                                                                                                       |
| 2026-04-17 | TD       | Phase 1 Chunk 10 — real lesson with a live class (pupil topic-set flow end-to-end)       | PASS — pupils completed topic-set attempts, teacher override path exercised. Satisfies Phase 1 §10 sign-off.                                                                                                                                                                                                                                                                                                                                         |
| 2026-04-17 | TD       | Phase 1 automated walker (`npm run test:human:phase1`)                                   | PARTIAL — topic 1.2 walked cleanly; `content:seed` hit FK restrict on topic 1.3 (`mesh-topology`, `star-topology`, `tcp-ip-layers`) vs existing `attempt_parts`; `npm run check` flagged Prettier on `DATA_MODEL.md`, `PHASE1_PLAN.md`, `src/routes/attempts.ts` (now auto-fixed). Seed idempotency fix carried into Phase 2 backlog.                                                                                                                |
| 2026-04-17 | TD       | Phase 2 go/no-go decision                                                                | **GO.** Phase 1 deliverables met (chunks 1–10 merged, real lesson PASS, ≥60 curated questions, DATA_MODEL current). Follow-ups into Phase 2: `content:seed` FK-restrict idempotency, Prettier gate regression prevention.                                                                                                                                                                                                                            |
| 2026-04-17 | TD       | Phase 1 automated walker re-run (`npm run test:human:phase1`)                            | PASS — 20/20 auto steps; report: `tmp/human-tests/phase1-20260417T182602Z.md`. Seeder idempotency fix landed (`content:seed` now upserts `question_parts` by `display_order`, preserving IDs so live `attempt_parts` no longer FK-restrict). Phase 1 sign-off complete.                                                                                                                                                                              |
| 2026-04-21 | TD       | Phase 2.5 automated walker (`npm run test:human:phase2`)                                 | PASS — 21/21 steps; report: `tmp/human-tests/phase2-20260420T235516Z.md`. Covers paper-layout chrome, countdown timer, autosave round-trip, per-question + whole-attempt submit, three print-to-PDF variants, and axe-core on all seven core pages. Satisfies PHASE2.5_PLAN.md §10 deliverable 2.                                                                                                                                                    |
| 2026-04-21 | TD       | Phase 2 + Phase 2.5 combined sign-off lesson (real class, every new widget type covered) | PASS — pupils completed a topic set containing at least one question of every new widget (trace_table_grid, matching, cloze_free, cloze_with_bank, cloze_code, logic_diagram, diagram_labels, flowchart, matrix_tick_single, matrix_tick_multi). Pupils described the experience as "looks like the real paper"; teacher accepted print-to-PDF as markable; no accessibility blockers observed. Combined Phase 2 chunk-9 + Phase 2.5 sign-off event. |
| 2026-04-21 | TD       | Phase 3 go/no-go decision                                                                | **GO.** Phase 2.5 deliverables met (chunks 2.5a–2.5j merged with tests green, walker PASS, combined sign-off lesson PASS, PUPIL_FEEDBACK rows 1–6 resolved, DATA_MODEL current, widget registry is single source of truth, no subject-vocab leaks, axe-core clean on seven core pages + one attempt page per new widget type).                                                                                                                       |
