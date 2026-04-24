# OCR J277 Revision Platform

> **AI agents:** read [AI_STARTING_POINT.md](AI_STARTING_POINT.md) first. It is the single bootstrap document and is kept up to date as the project evolves.

A topic-based adaptive revision web app for OCR GCSE Computer Science (J277), built for use in a single teacher's classroom first and designed to grow into a department-wide tool.

The app serves OCR-style questions, marks pupil responses against rubric-style mark points with LLM assistance, adapts difficulty to the individual pupil, and gives the teacher a clear view of what each pupil and class needs next.

> **Status (2026-04-17):** Phase 0 complete. Phase 1 signed off (see [RUNBOOK.md](RUNBOOK.md) §10). Phase 2 in progress — chunks 1 (paper chrome), 2 (per-type widgets), 3 (autosave), and 4 (optional countdown timer) merged on `main`; chunks 5–9 (review page, print-to-PDF, accessibility pass, teacher quality-of-life, lesson test) remain. See [PLAN.md](PLAN.md) and [PHASE2_PLAN.md](PHASE2_PLAN.md).

## Why this exists

Pupils get the most out of revision when:

- the questions look and feel like the real exam,
- feedback is short, specific, and tied to a mark point,
- the next question is pitched just above what they can already do,
- and the teacher can see at a glance who needs reteaching on what.

OCR's own examiner reports for J277 keep highlighting the same issues year after year: vague single-word answers, missing justification, one-sided extended responses, and imprecise algorithm/code work. This platform is designed specifically to surface and address those patterns.

## Core principles

1. **Curated content first, AI second.** A teacher-curated question bank with structured mark points exists before any LLM marking is wired in.
2. **The LLM never owns the source of truth.** Authentication, scoring, mastery, and the live question bank are all controlled by deterministic code and human approval.
3. **Every AI mark is auditable and overridable.** Confidence scores, evidence quotes, and a moderation queue are first-class features.
4. **Built for one classroom, designed for a department.** The MVP must be useful with one teacher and one class. Multi-class and multi-teacher come later.
5. **Pupil dignity matters.** Feedback is short, encouraging, examiner-style, and never sarcastic or punishing.
6. **Safeguarding and GDPR are not optional.** See [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md).

## What it is not

- Not a replacement for teaching. It is a revision and feedback tool.
- Not a fully autonomous AI tutor. A teacher is always in the loop on content and on contested marks.
- Not a content-farm for OCR-clone questions. Generated questions go through teacher approval and similarity checks.

## Target users

- **Pupils** (Year 10–11 in England, ages 14–16) sitting OCR J277.
- **The class teacher** (initially: just me) authoring questions, moderating AI marks, and viewing analytics.
- **Other CS teachers in the department** in later phases.
- **(Future) SLT / Head of Department** for cohort-level reporting.

## Tech stack (planned)

| Layer           | Choice                                                                  | Why                                                                                              |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Backend         | Node.js + TypeScript + Fastify                                          | One language across stack, strong typing for LLM JSON schemas                                    |
| Frontend        | Server-rendered HTML + HTMX, progressive enhancement                    | Works on locked-down school devices, low JS overhead                                             |
| Database        | PostgreSQL with `pgvector`                                              | Relational data for school reporting + vector search without a second DB                         |
| Auth            | Local accounts, Argon2 password hashing, optional Google SSO later      | Schools rarely allow third-party SSO without setup                                               |
| LLM             | OpenAI Responses API + Structured Outputs                               | Schema-conforming JSON for marking and generation                                                |
| Embeddings      | OpenAI `text-embedding-3-small` via pgvector                            | Duplicate detection, misconception clustering                                                    |
| Hosting         | Debian VM on the school's existing Proxmox hypervisor; LAN-only for MVP | Pupil data never leaves school premises; uses existing infrastructure; sole admin is the teacher |
| Background jobs | In-process queue (e.g. BullMQ on Redis) added in Phase 4                | Avoid premature infra                                                                            |

See [ARCHITECTURE.md](ARCHITECTURE.md) for detail.

## Repository layout (planned)

```text
exam_questions/
├── AI_STARTING_POINT.md       single bootstrap document for AI agents
├── README.md                  this file
├── DEV_SETUP.md               dev loop: prerequisites, Docker Postgres, VSCode tasks
├── PLAN.md                    phased development plan
├── RISKS.md                   risks & mitigations
├── RESOURCES_REQUIRED.md      everything needed to build & run this
├── ARCHITECTURE.md            system architecture
├── DATA_MODEL.md              database schema and relationships
├── SECURITY_AND_PRIVACY.md    GDPR, DPIA, safeguarding, auth
├── PROMPTS.md                 LLM prompt families and JSON schemas
├── package.json               npm scripts + dependencies
├── tsconfig*.json             TypeScript config (editor + build)
├── eslint.config.js           ESLint flat config
├── .prettierrc.json           Prettier rules (+ .prettierignore)
├── .editorconfig              editor-agnostic formatting
├── .nvmrc                     Node 22 LTS pin
├── .env.example               copy to .env (gitignored)
├── docker-compose.yml         dev Postgres 16 + pgvector on :5433
├── .dockerignore / .gitignore
├── .vscode/                   shared extensions, settings, launch, tasks
├── OCR_Docs/                  OCR source materials (spec, papers, mark schemes); see OCR_Docs/CONTENT_INDEX.md
├── scripts/                   admin scripts (db-init, backup, restore drill, Phase 0/1 human-test walkers, Debian bootstrap)
├── src/                       application code (Fastify app, routes, services, repos, templates, CLI scripts)
├── content/                   curated question bank + OCR mappings (Phase 1 seed lands in `content/curated/`)
├── prompts/                   (Phase 3+) versioned prompt templates
└── migrations/                numbered SQL migrations (0001–0033 currently)
```

## Getting started

Full step-by-step in [DEV_SETUP.md](DEV_SETUP.md). The short version:

```bash
git clone git@github.com:tomd1415/exam_questions.git
cd exam_questions
cp .env.example .env                 # then generate a SESSION_SECRET
npm install
npm run db:up                        # Postgres 16 + pgvector in Docker on :5433
npm run db:migrate                   # apply 0001…latest migrations
npm run dev                          # Fastify app on :3030 with hot reload
```

Dev is tested on **Gentoo Linux**; production target is **Debian**. The database runs in Docker locally and natively on the Debian server — see [DEV_SETUP.md](DEV_SETUP.md) for the rationale and for what differs in production.

## Documentation map

If you only read three documents, read these in order:

1. [PLAN.md](PLAN.md) — what gets built, in what order, with what success criteria.
2. [RISKS.md](RISKS.md) — what is most likely to go wrong, and the plan for it.
3. [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) — non-negotiable for any system holding pupil data.

Then for build-time reference:

- [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [PROMPTS.md](PROMPTS.md), [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md).
- [OCR_Docs/CONTENT_INDEX.md](OCR_Docs/CONTENT_INDEX.md) — catalogue of OCR source materials (spec, sample papers, three series of past papers, mark schemes, examiners' reports).

## OCR copyright notice

OCR specifications, past papers, mark schemes, and examiner reports are © OCR. They are used here as a _pattern source_ for question style, command words, mark tariffs, and misconceptions. The platform must not reproduce OCR copyrighted material verbatim in pupil-facing screens. Generated questions go through similarity detection against source papers (see [PLAN.md](PLAN.md), Phase 5).

## Licence

To be decided. Default assumption: private repository for departmental use until Phase 7. If released publicly, pupil data, OCR-derived content, and the question bank itself stay private.

## Author

Built by a serving Computer Science teacher for their own GCSE classes.
