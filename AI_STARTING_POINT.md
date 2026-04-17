# AI Starting Point

> **Read this first.** If you are an AI agent (Claude Code, Cursor, or any other) picking up this project for the first time, this document is your single entry point. Read it end-to-end before opening any other file.
>
> **Keep this file current.** Whenever the project's status, structure, conventions, or document set changes — for example a new planning document is added, a phase begins or finishes, a tech-stack choice changes, or a new external resource is wired in — update the relevant section of this file in the same change. A future agent should be able to bootstrap from this document alone.

## TL;DR

This is an active build of a topic-based adaptive revision web app for **OCR GCSE Computer Science (J277)**, used initially in a single UK teacher's classroom and designed to grow into a department-wide tool. Phase 0 is complete; Phase 1 is in progress on `main`.

The platform serves OCR-style questions, marks pupil responses against rubric-style mark points with LLM assistance (kept on a tight leash), adapts difficulty per pupil, and gives the teacher actionable analytics. The LLM is added late and is never the source of truth.

## Project status (as of 2026-04-17)

- **Phase:** Phase 0 complete. Phase 1 signed off (see [RUNBOOK.md](RUNBOOK.md) §10). Phase 2 in progress — chunks 1 (paper chrome), 2 (per-type widgets), 3 (autosave), and 4 (optional countdown timer) all merged to `main`; chunks 5–9 (review page, print-to-PDF, accessibility pass, teacher quality-of-life, lesson test) outstanding.
- **Code:** `src/` populated. Fastify app with `routes/`, `services/`, `repos/`, `templates/`, `static/`, `scripts/`, `db/`, `lib/`. Tests in `tests/` across unit, integration, and HTTP (Fastify `inject`) layers; `npm run check` gate is green on `main` (290+ tests).
- **Migrations:** `0001_curriculum` → `0011_class_timer`. Migration runner is `npm run db:migrate` (script at `src/db/migrate.ts`).
- **Git:** Remote `https://github.com/tomd1415/exam_questions.git`, branch `main`.
- **Dev environment:** See [DEV_SETUP.md](DEV_SETUP.md). Gentoo Linux host, Dockerised Postgres 16 + pgvector on `:5433`.
- **Hosting (production):** Debian VM on the school's existing Proxmox hypervisor, inside the school network. LAN-only for the MVP (no home access). The user is the sole admin. Backups are handled by the school's existing regime.
- **Pupil data:** None live. Do not solicit any until the DPIA is signed off.

The next concrete deliverable is closing out Phase 2: Chunk 5 (review page with model answer side-by-side) is next up; Chunks 6–9 (print-to-PDF, accessibility pass, teacher quality-of-life, real lesson test) follow. See [PHASE2_PLAN.md](PHASE2_PLAN.md).

## Who the user is

- A serving UK secondary-school Computer Science teacher.
- Teaches OCR J277.
- Technically capable (writes code in evenings, runs Linux on Gentoo).
- Building for their own class first, with the explicit intent of expanding to the rest of the department later.
- Email recorded in memory: `tomd1415@gmail.com`.

When suggesting features, design choices, or trade-offs, prioritise:

1. Single-teacher / single-class MVP usefulness over scale.
2. UK schools context: GDPR, KCSIE safeguarding, often-locked-down IT, Chromebooks/iPads common.
3. Spec accuracy for J277 (verify against the spec PDF, do not improvise).
4. Realistic teacher workload — a teacher will not maintain 200 questions a week by hand.

There is more in [memory/user_role.md](#memory-system-on-disk).

## Document index — read in this order

### Tier 1 — read before doing anything

| Doc                                                | Length | What it tells you                                                                                                                                                                     |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](README.md)                             | short  | Project purpose, core principles, planned tech stack, repo-layout target, doc map.                                                                                                    |
| [PLAN.md](PLAN.md)                                 | medium | Eight phases (0–7) with goals, builds, "do not build" lists, user tests, success criteria, and a section recording what changed from the original brainstorm.                         |
| [RISKS.md](RISKS.md)                               | medium | 24 risks across 7 categories with L×I scoring; explains why design choices look the way they do. The five highest-scoring risks drive the architecture.                               |
| [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) | medium | UK GDPR roles, DPIA requirements, what is and is not sent to the LLM, safeguarding flow for disclosures in answer boxes, prompt-injection assumptions, retention. **Non-negotiable.** |

### Tier 2 — build-time references

| Doc                                            | Length | What it tells you                                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DEV_SETUP.md](DEV_SETUP.md)                   | medium | How to run the dev loop: Node/Docker prerequisites, `.env`, Postgres+pgvector container on port 5433, npm scripts, VSCode tasks and debug configs, Gentoo→Debian differences, troubleshooting.                        |
| [PHASE1_PLAN.md](PHASE1_PLAN.md)               | long   | The chunk-by-chunk implementation plan for Phase 1, ordering and dependencies, per-chunk tests + exit criteria, and the resolved decisions from the start-of-phase review.                                            |
| [ARCHITECTURE.md](ARCHITECTURE.md)             | medium | Component diagram, services-vs-repos split, request lifecycles, the single LLM client wrapper, kill switch, target folder structure, things deliberately out of scope.                                                |
| [DATA_MODEL.md](DATA_MODEL.md)                 | long   | Full Postgres schema with phase markers per table; conventions; indexes; retention policy.                                                                                                                            |
| [HUMAN_TEST_GUIDE.md](HUMAN_TEST_GUIDE.md)     | long   | Per-phase (and per-chunk within Phase 1) human sign-off walkthroughs; automated walker entry points; pre-reqs and fixtures for manual verification.                                                                   |
| [RUNBOOK.md](RUNBOOK.md)                       | medium | Operational runbook: prod provisioning, TLS, firewall, backups, restore drill, human-test sign-off log (§10).                                                                                                         |
| [PROMPTS.md](PROMPTS.md)                       | long   | Four prompt families (generation, marking, clustering, summaries) with inputs, Zod-style output schemas, safety gates, evaluation fixtures, and version-control rules. Header points to the OpenAI Documentation MCP. |
| [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) | medium | People, hardware, hosting, third-party APIs (incl. OpenAI MCP reference), software dependencies, content sources, recurring ops checklist, Phase-0 setup checklist.                                                   |
| [DPIA.md](DPIA.md)                             | medium | Data protection impact assessment draft; gate on the Phase 1 "real lesson" sign-off until the DPO and safeguarding lead have countersigned.                                                                           |

### Tier 3 — source material

| Doc                                                    | Length | What it tells you                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [OCR_Docs/CONTENT_INDEX.md](OCR_Docs/CONTENT_INDEX.md) | medium | Catalogue of all 24 OCR source documents (specification, teacher support, sample papers, three series of past papers / mark schemes / examiners' reports), their page counts, and how each feeds into which phase. |

### File on disk that is not a planning doc

| File                     | Purpose                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [.gitignore](.gitignore) | Excludes `OCR_Docs/**` (allowlisting `CONTENT_INDEX.md`), `content/source/**`, `.env`, `node_modules/`, build artefacts, editor folders. |

## Hard rules (do not break these without explicit user instruction)

1. **The LLM is not the source of truth.** Authentication, scoring, mastery, the live question bank, and audit are deterministic code. The LLM assists; it does not decide.
2. **No pupil data in real form until the DPIA is signed off.** Until then, work with synthetic data.
3. **No PII in any LLM payload.** Use the pseudonym field. The pre-call redactor strips display names, school name, and known patterns.
4. **OCR copyright material is not committed to git, ever.** It is in `OCR_Docs/` and the `.gitignore` already excludes it. Do not move it elsewhere without re-checking the rule.
5. **Generated questions are not near-duplicates of OCR papers.** Embedding-similarity check is mandatory in Phase 5; teacher approval is required.
6. **Every AI mark is auditable and overridable.** Confidence, evidence quotes, and a moderation queue are first-class features from Phase 3.
7. **Kill switch first.** A single env flag (`LLM_ENABLED=false`) must disable every LLM call and route open responses to teacher-marked. The system stays usable when the API is down, expensive, or wrong.
8. **Phases are sized to be pausable at term boundaries.** Do not roll multiple phases into one PR.
9. **"Do not build" lists in [PLAN.md](PLAN.md) are binding.** Push new ideas into a backlog; do not let them sneak into the current phase.
10. **Verify OpenAI API surface against the MCP**, not against training-cutoff knowledge (see Tools, below).

## Tools, references, and external resources

### OpenAI Documentation MCP (canonical for API work)

`https://developers.openai.com/mcp`

Use whenever touching anything OpenAI (Responses API, Structured Outputs, model ids, pricing, embeddings, ZDR terms). Treat this as the source of truth, not your training-cutoff knowledge. Full description in [RESOURCES_REQUIRED.md §4](RESOURCES_REQUIRED.md); operative rule in [PROMPTS.md](PROMPTS.md) header.

### OCR source material on disk

Catalogued in [OCR_Docs/CONTENT_INDEX.md](OCR_Docs/CONTENT_INDEX.md). Includes:

- The full J277 specification.
- Teacher support: Getting Started, Exploring Our Question Papers, Scheme of Work (xlsx).
- Sample papers for J277/01 and J277/02.
- Three live series: May 2022, May 2023, May 2024 — each with question paper + mark scheme + examiners' report for both components.

Use this material as a **pattern source** (style, command words, mark tariffs, misconceptions). Do not reproduce verbatim in pupil-facing screens.

### Memory system on disk

Persistent file-based memory lives at:

`/home/duguid/.claude/projects/-home-duguid-projects-exam-questions/memory/`

Index is `MEMORY.md`. Current entries include:

- `user_role.md` — UK secondary CS teacher building tools for own class.
- `reference_openai_mcp.md` — pointer to the OpenAI Documentation MCP.
- `project_dev_prod_split.md` — Gentoo dev with Dockerised Postgres on :5433; production is a Debian VM on the school's Proxmox, LAN-only, user is sole admin.

Add new memories there when you learn something durable about the user, the project, or external resources. Do not duplicate things that this `AI_STARTING_POINT.md` or another planning doc already says.

## Conventions

### Tech stack (planned, not yet built)

Node.js + TypeScript + Fastify on the server; server-rendered HTML + HTMX on the client; PostgreSQL with `pgvector`; Argon2id for passwords; OpenAI Responses API + Structured Outputs in Phase 3+; Redis only from Phase 4. Production runs on an on-premises Debian VM on the school's Proxmox hypervisor, LAN-only for the MVP. Full detail in [ARCHITECTURE.md](ARCHITECTURE.md) and [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md).

### Folder structure (actual as of 2026-04-17)

```text
exam_questions/
├── AI_STARTING_POINT.md        ← this file (read first)
├── README.md
├── DEV_SETUP.md                how to run the dev loop
├── PLAN.md / PHASE1_PLAN.md    phased plan + current-phase chunk plan
├── RISKS.md / DPIA.md
├── RESOURCES_REQUIRED.md
├── ARCHITECTURE.md / DATA_MODEL.md
├── SECURITY_AND_PRIVACY.md
├── PROMPTS.md
├── HUMAN_TEST_GUIDE.md         per-phase manual sign-off walkthroughs
├── RUNBOOK.md                  production ops, TLS, backups, sign-off log
├── package.json                deps + npm scripts
├── tsconfig.json / tsconfig.build.json
├── eslint.config.js            flat config, type-checked rules
├── .prettierrc.json / .prettierignore / .editorconfig / .nvmrc
├── .env.example                → copy to .env (gitignored)
├── docker-compose.yml          dev Postgres 16 + pgvector on :5433
├── .dockerignore / .gitignore
├── .vscode/                    extensions.json, settings.json, launch.json, tasks.json (shared)
├── OCR_Docs/                   catalogued; gitignored except CONTENT_INDEX.md
├── scripts/                    db-init, backup, restore drill, Phase 0/1 human-test walkers
├── migrations/                 0001_curriculum … 0010_per_question_mode
├── src/
│   ├── app.ts / index.ts / config.ts
│   ├── db/                     migration runner
│   ├── lib/                    shared helpers (csrf, flash, auth preHandlers, …)
│   ├── repos/                  users, sessions, classes, curriculum, questions, attempts, audit
│   ├── services/               auth, classes, questions, attempts, audit, marking/
│   ├── routes/                 auth, questions (legacy /q/1), attempts, admin-classes, admin-questions, admin-attempts
│   ├── templates/              Eta templates (_chrome, _admin_*_body, attempt_edit, attempt_review, …)
│   ├── static/                 CSS, minimal JS
│   └── scripts/                create-user, seed-curated-content, setup-lesson CLIs
├── tests/                      unit/, integration/ (DB-backed), http/ (Fastify inject), helpers/
├── content/                    curated question bank (Phase 1 seed)
└── prompts/                    (Phase 3+) versioned prompt templates
```

### Naming and style

- Markdown documents use sentence case in headings, ATX-style headings (`#`), and tables for catalogues.
- Code (when it arrives) will be TypeScript, ESLint + Prettier, services-do-not-import-each-other-circularly. See [ARCHITECTURE.md](ARCHITECTURE.md).
- Database identifiers are `snake_case` and pluralised for tables.
- Comments in code: avoid unless the _why_ is non-obvious. Identifiers should explain _what_.

### Communication

- Be concise.
- Never write pupil-facing copy (feedback, prompts, emails) without checking the tone rules in [PROMPTS.md](PROMPTS.md) and [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md): short, encouraging, examiner-style, Year-10 reading level, no sarcasm.
- For risky or destructive actions (deletes, force-pushes, anything that touches the server when it exists), confirm before acting.

## Where to start work

If the user asks you to "start building", they almost certainly mean **Phase 0** as defined in [PLAN.md](PLAN.md). Re-read that section before scaffolding anything. Confirm with the user before procuring hosting, registering domains, or creating accounts that cost money.

If the user asks an open question about design, prefer pointing to the relevant planning doc rather than re-deriving an answer. If the doc is wrong or out of date, **fix the doc** in the same change.

If the user asks for something that is on a "do not build" list for the current phase, surface that conflict first, do not silently break the rule.

## Keeping this document up to date

This file is the bootstrap document for every future AI session. If anything below changes, update the matching section here in the same change:

- Project status (phase, code state, hosting, pupil data status).
- Who the user is.
- Document index (a new doc was added, removed, renamed, or substantially restructured).
- Hard rules (a rule was added, removed, or revised).
- Tools and external resources (a new MCP, API, or external dataset was wired in).
- Conventions (tech stack changed, folder structure changed, naming changed).
- Folder structure diagram.

A short, accurate `AI_STARTING_POINT.md` is more valuable than a long stale one. If a section becomes obsolete, **delete it** rather than leaving it to mislead.
