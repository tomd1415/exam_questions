# Development Plan

A phased plan to build the OCR J277 revision platform. Each phase ends with a usable artefact, a test with real pupils or against real teacher workflows, and an explicit go/no-go decision before the next phase begins.

## Plan-level principles

- **Ship something usable to one class at the end of every phase from Phase 1 onward.** Even if the only AI in the system is none, pupils must be able to log in and revise.
- **No phase finishes until it has been tested with real users.** Either pupils, the teacher, or both, depending on phase.
- **The LLM is added late and added carefully.** Phases 1 and 2 contain zero LLM dependency. The system must remain useful if the OpenAI API is down.
- **Data protection is a Phase 0 deliverable, not an afterthought.** A DPIA exists before any pupil enters their first piece of personal data.
- **Each phase has a "do not build" list.** This is at least as important as what is built.

## Phase 0 — Foundations, governance, and the smallest possible loop

**Duration estimate:** 2–3 weeks of evening work.
**Hard prerequisite for all other phases.**

### Goal

Have a deployable skeleton, a written DPIA, a copy of the OCR specification mapped to a database, and a single end-to-end happy path from pupil login to a static "hello world" question.

### Build

- Repository, TypeScript project, lint/format, basic CI.
- Production VM live on the school's Proxmox hypervisor, with documented firewall rules (pupils → :443, VM → `api.openai.com`:443) captured in `RUNBOOK.md`. Pupil-facing access is LAN-only for the MVP. The school's existing backup regime is confirmed to capture the application VM; a DB-level `pg_dump` / `pg_restore` drill is performed and recorded.
- PostgreSQL set up with migrations tooling.
- Auth scaffold: local accounts, Argon2 hashes, session cookies. No "register yourself"; teacher creates accounts.
- Curriculum seed data: J277/01 and J277/02 components, all topics and subtopics, all command words. Hand-keyed from the spec, reviewed twice.
- One handcrafted question in the database, displayed at `/q/1`.
- A signed-off Data Protection Impact Assessment (DPIA), privacy notice, and acceptable-use statement. See [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md).
- Backup and restore tested at least once.

### Do not build

- AI of any kind.
- Adaptive logic.
- Question authoring UI (use SQL or a seed file for now).
- Any analytics.

### User test

- The teacher logs in, opens `/q/1`, types an answer, submits. The submission appears in the database. The pupil account also works. The system is then deliberately rebooted and the data survives.

### Success criteria

- DPIA is signed off (by the user, in their teacher capacity, and shared with their DPO/SLT if required by the school).
- Login works. A pupil cannot see another pupil's data.
- Backup restore demonstrably works.

### Go/no-go before Phase 1

- DPIA is approved by the relevant person at school, or there is an explicit decision to keep the project on a personal device with no real pupil data until that approval lands.
- Firewall rules and TLS approach are documented in `RUNBOOK.md`.
- DB-level restore drill has succeeded at least once.

---

## Phase 1 — Curated content model and a real revision loop

**Duration estimate:** 3–4 weeks.

### Goal

A pupil can log in, choose a topic, answer a small set of curated questions, see their own raw score, and resume later. The teacher can author questions through a basic UI.

### Build

- Full question schema (see [DATA_MODEL.md](DATA_MODEL.md)).
- Teacher question authoring UI: stem, parts, marks, command word, model answer, mark points, common misconceptions, difficulty.
- 60–100 curated questions across both components, weighted toward whatever the user is teaching this term.
- Pupil flows: pick a topic → answer set of 5–10 questions → save and resume → submit.
- Deterministic marking only: multiple choice, exact match, tick-box.
- Open-response questions are stored but show "your teacher will mark this" for now.
- Class membership: the teacher creates a class, adds pupils, assigns a topic set.

### Do not build

- LLM marking.
- Adaptive selection (questions are presented in a fixed teacher-defined order).
- Cross-class analytics.
- Parent / SLT views.

### User test

- One real lesson with the teacher's class. The teacher assigns a topic. Pupils complete it. The teacher reviews submissions in the admin UI.

### Success criteria

- Zero data loss across the lesson.
- Pupils can use the app without teacher support after a 2-minute demo.
- The teacher can author a new question in under 5 minutes.

### Risks specific to this phase

- Schema churn. Mitigation: agree the schema in writing in [DATA_MODEL.md](DATA_MODEL.md) before writing migrations.
- Over-investing in author UX before knowing the workflow. Mitigation: text-area-heavy authoring is fine in Phase 1.

---

## Phase 2 — OCR-style presentation and objective marking polish

**Duration estimate:** 2–3 weeks.

### Goal

The pupil-facing experience looks and feels like serious exam practice without being intimidating. Objective marking gives instant, well-formatted feedback.

### Build

- OCR-style paper layout for question sets (header, marks-in-margin, line-ruled answer space sized to mark tariff). The prototype HTML is the visual seed.
- Question types fully supported in the renderer: tick-box, short text, medium text, extended response, code/algorithm response (monospace input + light syntax styling).
- Optional countdown timer per set.
- Autosave every N seconds and on blur.
- "Submit and review" page showing per-question objective marks and the model answer for objective items.
- Print-to-PDF mode for paper-style sets.
- Accessibility pass: keyboard navigation, focus states, contrast, dyslexia-friendly font option, screen reader labels on every input.

### Do not build

- Anything LLM-driven.
- Adaptive routing.
- Pupil-visible analytics.

### User test

- The teacher's class uses it for a full revision lesson. Collect feedback specifically on: does it feel like an exam? Are the answer boxes the right size? Is the feedback panel useful?

### Success criteria

- Pupils describe the experience as "looks like the real paper" without being asked.
- No accessibility blocker discovered with a teacher-led screen-reader pass and a colour-blindness simulator.
- Print-to-PDF produces something a teacher would happily mark on paper.

---

## Phase 3 — LLM-assisted marking with full audit trail

**Duration estimate:** 4–6 weeks. **This is the highest-risk phase.**

### Goal

Open-response questions are marked with LLM assistance. Every AI mark is auditable, has a confidence score, and is easy for the teacher to override. The teacher trusts the system enough to use it on a real homework.

### Build

- OpenAI Responses API client wrapper with structured outputs against a versioned JSON schema (see [PROMPTS.md](PROMPTS.md)).
- Marking pipeline:
  1. Deterministic pre-checks (empty? too short? contradiction obvious?).
  2. LLM marking call with rubric, mark points, accepted alternatives, misconceptions, OCR-style rules.
  3. Safety gate: low confidence, weak evidence, high marks on a thin answer → flag for moderation.
- Moderation queue UI for the teacher: side-by-side pupil answer, AI mark, evidence quotes, override controls.
- Pupil-facing feedback: "What went well / How to gain more marks / Next time…", capped to 3 short blocks, written at a Year 10 reading level.
- Audit table: prompt version, model id, raw response, latency, token cost, override status.
- Cost dashboard (teacher-only): cost-per-pupil-per-week, projected monthly cost.
- Kill switch: a single setting that disables all LLM calls and falls back to "your teacher will mark this".

### Do not build

- Generation of new questions.
- Adaptive sequencing.
- Misconception clustering across pupils.

### User test

- Pilot with one topic and one class. The teacher marks the same answers in parallel for the first week. Compare distributions. Investigate every disagreement.

### Success criteria

- On the pilot topic, AI marks fall within ±1 mark of the teacher mark on at least 85% of responses.
- The teacher can clear a 30-pupil moderation queue in under 15 minutes.
- The cost per pupil per week is within an explicit budget set in [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md).
- Zero pupil-facing feedback contains hallucinated facts about the spec, verified by manual review of a 50-response sample.

### Hard rule

AI marks shown to pupils in this phase are explicitly labelled as "marked with AI assistance — your teacher will check". This label only comes off when Phase 6 analytics show consistent agreement.

---

## Phase 4 — Adaptive sequencing

**Duration estimate:** 3–4 weeks.

### Goal

The next question is chosen for each pupil based on their mastery profile rather than a fixed order. Strong pupils get stretched, weak pupils get scaffolded, no pupil is buried.

### Build

- Mastery model: per pupil × topic × command word × response-type, scored 0–100 with recency and confidence weighting.
- Difficulty model on questions: 1–9 grade band × 1–3 challenge step within band, separately tracked per response type.
- Question selector: 70% in target zone, 20% one band easier, 10% one band harder. Frustration protection: never serve three "fail" questions in a row.
- "Weakest areas" mode and "spaced retrieval" mode for pupils.
- Live calibration: difficulty estimates update from real attempt data once a question has ≥30 attempts.

### Do not build

- AI question generation.
- Cross-class trends.

### User test

- A/B test on the teacher's class: half the pupils on adaptive, half on fixed order, swapped halfway. Compare engagement, completion rate, and post-test scores.

### Success criteria

- Adaptive group reports the experience as "challenging but fair" at higher rates than fixed group.
- No pupil ends a session with mastery scores lower than they started in their target topic without an explanation in the audit log.
- The teacher can read and trust a single pupil's mastery profile in under 30 seconds.

---

## Phase 5 — AI question generation with teacher approval

**Duration estimate:** 4–6 weeks.

### Goal

The question bank grows without proportional teacher authoring time. Generated questions are spec-aligned, OCR-style, original, and only enter the live bank after teacher approval.

### Build

- Retrieval over: spec wording (chunked + embedded), curated past-question structures, mark scheme patterns, examiner-report misconceptions.
- Generation prompt producing a full question package per [PROMPTS.md](PROMPTS.md): stem, parts, marks, model answer, mark points, misconceptions, difficulty rationale, command word, topic mapping.
- Validator pass (separate prompt) that re-checks the generated question against the spec and against the originality rule.
- Duplicate detection via embedding similarity against existing bank and against any imported source-paper text.
- Teacher approval queue: read, edit, approve, reject. Bulk approval is not a feature.
- "Generated from" provenance on every question.

### Do not build

- Auto-publishing of any question.
- Generation of whole papers (Phase 7).

### User test

- The teacher generates a batch of 30 questions. Time how long approval/edit/reject takes. Sample 10 against the spec line-by-line for accuracy.

### Success criteria

- ≥70% of generated questions accepted with only light editing.
- Zero questions accepted that are near-duplicates of OCR source material (similarity threshold defined in [PROMPTS.md](PROMPTS.md)).
- Per-question generation cost within budget.

---

## Phase 6 — Teacher analytics and misconception intelligence

**Duration estimate:** 3–4 weeks.

### Goal

The dashboard tells the teacher something they did not already know, and saves them time planning the next lesson.

### Build

- Class heatmap: topic × pupil, coloured by mastery.
- Command-word weakness view.
- "Most missed mark points this week" list with example pupil responses.
- Misconception cluster view (embedding-based, with teacher-editable labels).
- Low-confidence AI marks queue persisted from Phase 3.
- Pupils-stalled-at-band list, pupils-ready-for-paper-mode list.
- Printable / exportable summaries (PDF and CSV) for parents' evening and for SLT.

### Do not build

- Cross-school benchmarking.
- Live notifications. (Email digest is fine; push is not.)

### User test

- Teacher uses only the dashboard to plan the next lesson. Compare the resulting plan to what they would have planned without the tool. Was anything new revealed?

### Success criteria

- Teacher reports at least one "I would not have spotted that" insight per week.
- Lesson planning time reduced or kept flat (tool must not add work).

---

## Phase 7 — Hardening, paper mode, and department rollout

**Duration estimate:** 4–6 weeks.

### Goal

Move from "the teacher's class uses it" to "the department uses it". Paper mode supports mock-exam practice. Operational cost and stability are well-understood.

### Build

- Paper builder: by component, by topic mix, by total marks, by duration.
- Mock exam mode with strict no-feedback-until-end behaviour.
- Multi-teacher support: classes per teacher, shared question bank, per-teacher dashboards.
- Bulk pupil import (CSV from school MIS).
- Account reset flows.
- Retention policy enforcement (auto-delete inactive pupil data per [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)).
- Cost controls: per-class API budget, alerts.
- Versioned prompt registry.
- Operational runbook (start, restart, restore from backup, rotate API key).

### User test

- Whole-cohort mock under classroom conditions across multiple devices and browsers.

### Success criteria

- Stable under simultaneous use by at least one full class on the slowest devices the school owns.
- A second teacher in the department can run a lesson with the platform after a 30-minute walkthrough.
- Monthly running cost is within the agreed budget with margin.

---

## Design decisions worth recording

Choices made during planning that are not obvious from the phase list and would be expensive to revisit:

- **Phase 0 exists explicitly.** Governance, hosting, and the DPIA are deliverables, not assumptions.
- **DPIA, privacy notice, and safeguarding flow are blockers before pupil data enters the system**, not "important". Working with under-16s in a UK school raises the threshold.
- **The Phase 3 kill switch is a first-class feature.** The system must remain usable when the LLM is unavailable, expensive, or wrong.
- **AI marking runs in parallel with teacher marking on the pilot topic** before any AI mark is shown to a pupil unlabelled. Moderation alone is not enough.
- **Originality controls in Phase 5 are mandatory.** Embedding similarity against source papers gates publication; teacher approval is the second gate.
- **Multi-teacher support is held back to Phase 7.** Designing for multiple teachers from day one is the fastest way to ship nothing.
- **No Redis until Phase 4.** No queues are needed for the early loop.
