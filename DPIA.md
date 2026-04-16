# Data Protection Impact Assessment (DPIA)

> **Status: working draft.** This document is not valid until it has been
> reviewed, amended as necessary, and signed by the school's Data
> Protection Officer (DPO) **and** a member of SLT with safeguarding
> responsibility (§8). Until both signatures are in place, the platform
> must not process real pupil data. Phase 1 may proceed on synthetic/test
> data only, per [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §DPIA.

- **Project:** exam_questions (OCR GCSE Computer Science J277 revision
  platform).
- **Data controller:** the school.
- **Data processor:** the project owner (teacher), operating the app on a
  school-provided Debian VM.
- **Author of this draft:** the project owner (teacher).
- **Date of draft:** 2026-04-16.
- **Phase at time of draft:** end of Phase 0 (foundations). No pupil
  data has been processed by the live system.
- **Review cadence:** termly, and before any phase that changes the
  scope of processing (notably Phase 3, which introduces an LLM
  sub-processor).

This DPIA follows the eight items required by
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Data Protection
Impact Assessment (DPIA)". It cross-references rather than duplicates
the detail in [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md),
[RISKS.md](RISKS.md), and [DATA_MODEL.md](DATA_MODEL.md), so those
documents are load-bearing for this assessment.

## 1. Nature, scope, context, and purposes of processing

**Nature.** A web application, served only on the school's internal
network (LAN-only), that lets a pupil sign in, read a past-paper-style
question, type an answer, and submit it. Teachers can review those
submissions. In later phases (3+), an external LLM service (OpenAI) is
used to produce a first-pass mark against a teacher-authored rubric; a
teacher always has the final say. No pupil data leaves the school VM
in Phase 0–2.

**Scope.**

- Personal data collected per pupil: `display_name` (first name +
  initial, teacher-only), `username` (login identifier), `password_hash`
  (Argon2id — not reversible), `pseudonym` (a stable, non-identifying
  code used in any AI-bound payload), class membership, and the pupil's
  own attempts and marks. No DOB, no contact details, no SEND /
  behaviour / attendance flags, no photos, no free-text "notes" field.
  See [DATA_MODEL.md](DATA_MODEL.md) §"People and groups" for the exact
  schema and [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)
  §"Data minimisation" for the rules that gate additions.
- Personal data collected per teacher: display name, username,
  password hash, role, class memberships, and an append-only audit
  trail of their actions on pupil records.
- Free-text answers written by pupils. These may, unintentionally,
  contain identifying information (own name, classmates' names, school
  name) or safeguarding-relevant content — this is anticipated by
  design (see §3.3 and §4.3 below).

**Context.** State-school teaching context, UK, KS4 (pupils aged 14–16,
with some Year 9 pupils aged 13 where J277 runs early). Pupils are
children; a substantial minority are under 13 at some point during the
programme. Pupils and parents have a legitimate expectation that
curriculum tools keep pupil work on school infrastructure.

**Purposes.** Revision, formative assessment, teacher
feedback, and (Phase 3+) LLM-assisted first-pass marking of open
responses against a teacher-authored rubric. Not used for
summative grading, reporting to parents, or any profiling decision
that has legal or significant effects on the pupil.

## 2. Necessity and proportionality

**Lawful basis.** UK GDPR Art. 6(1)(e) — public task. The platform
supports the pupil's education at a state school, under the school's
general statutory duty to provide education. AI-marking (Phase 3+)
additionally relies on Art. 6(1)(a) — consent — obtained from parents
through a parent-facing privacy notice, with a meaningful opt-out
(objective-only marking plus teacher-marked open responses).

**Special category data.** None collected. SEND status, ethnicity,
religion, and health data are explicitly out of scope.

**Necessity.** The fields listed in §1 are the minimum needed to
operate a personalised, class-scoped revision tool with an auditable
trail. Each field has been tested against the question "could we
operate without this?":

- `username` + `password_hash`: needed to authenticate a pupil to a
  personalised view of their own attempts. Local accounts (no SSO) were
  chosen because many pupils have no school email and SSO introduces
  a cross-border sub-processor.
- `display_name`: needed for the teacher UI to recognise pupils.
  Truncated to first-name + initial by convention.
- `pseudonym`: the only identifier ever sent to the LLM in Phase 3+.
  Allows a teacher to correlate an LLM-marked attempt back to the pupil
  locally, without the LLM ever seeing a name.
- Attempts / marks / feedback: the actual content of the service.
- Audit trail: required for accountability (overrides, deletions,
  logins).

**Proportionality.** A simpler alternative — pen-and-paper, or a
generic classroom tool — was considered and rejected for the parts of
the workflow where automation genuinely saves teacher time (objective
marking, topic tracking) or demonstrably helps pupils (immediate
feedback against a rubric). For the parts that can reasonably be done
without personal data (browsing the question bank, practice under a
guest session), the platform supports that mode.

## 3. Risks to data subjects

The authoritative risk register is [RISKS.md](RISKS.md). This section
lists the risks specifically affecting pupils as data subjects, and
summarises the impact. "Pupils under 13" is called out where
applicable, per ICO guidance that children merit specific protection.

### 3.1 Breach of pupil personal data (RISKS 1.1)

Loss of confidentiality of pupil account data, attempts, or marks —
via misconfiguration, VM compromise, or credential theft.

- **Impact on pupils:** distress; possible real-world consequences if
  free-text answers contain identifying or safeguarding-relevant
  content; possible notifiable incident under UK GDPR Art. 33.
- **Impact heightened for under-13s:** yes — children's data is given
  extra weight in ICO enforcement and in school safeguarding policy.

### 3.2 Pupil PII transmitted to OpenAI (RISKS 1.2; Phase 3+ only)

A pupil's answer, despite the redactor, includes their own or a
classmate's name, or another identifier.

- **Impact on pupils:** their words are processed outside the school
  network by a US-based sub-processor. Even with the zero-data-retention
  account setting, transient logs or moderation reviews could exist for
  a short window in the provider's infrastructure.
- **Impact heightened for under-13s:** yes, for the same reason as §3.1,
  and because parental expectations of AI exposure vary more for
  younger pupils.

### 3.3 Safeguarding disclosure in an answer box (RISKS 1.3)

A pupil types content indicating self-harm, abuse, or significant
distress into an answer box.

- **Impact on pupils:** the disclosure must reach a trained adult
  quickly. If the platform silently fails to flag it, the pupil may
  believe an adult has seen it when none has.
- **Impact heightened for under-13s:** yes — younger pupils are
  especially likely to disclose indirectly (e.g. through a seemingly
  on-topic answer).

### 3.4 Account misuse and impersonation (RISKS 1.4)

Pupils share credentials; a device is left logged-in; a pupil writes
answers under another pupil's identity.

- **Impact on pupils:** misattribution of attempts; possible
  inappropriate content written under a victim's account.

### 3.5 AI hallucination in marks or feedback (RISKS 2.1; Phase 3+)

The LLM awards marks or writes feedback that is not supported by the
rubric.

- **Impact on pupils:** pupils revise the wrong thing; trust in
  feedback is damaged.

### 3.6 Prompt-injection attempts by pupils (RISKS 4.3; Phase 3+)

Pupils discover that answer text can contain instructions to the
underlying model. They try to coerce high marks, extract system
prompts, or embed content they would not put into a normal answer.

- **Impact on pupils:** their own and classmates' records could
  contain entries that look like behaviour flags when they are really
  curiosity. Handled as learning opportunities, not as discipline,
  per RISKS 4.3.

### 3.7 Rights delivery failure

The school is unable to meet a subject access / erasure / rectification
request in the statutory window because the operational path is not
tested end-to-end.

- **Impact on pupils / parents:** regulatory right denied or delayed.

## 4. Measures to mitigate those risks

The full mitigation catalogue lives in
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) and
[RISKS.md](RISKS.md). The measures that matter for this DPIA are:

**Data minimisation by schema.** The `users` table has no DOB, no
contact details, no SEND flags, and no free-text notes column. See
[DATA_MODEL.md](DATA_MODEL.md) and
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Data
minimisation". _(Covers 3.1, 3.2.)_

**Pseudonymisation for AI payloads.** The LLM only ever sees the
`pseudonym` field, never `display_name` or `username`. A redactor
also strips pupil display names, common name patterns, and the school
name from the answer text before the call. See
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"What is sent to
the LLM". _(Covers 3.2.)_

**Local-first infrastructure.** App and database run on a Debian VM
on the school's own Proxmox hypervisor. Pupil data never leaves the
school network in normal operation. No third-party hosting, analytics,
or trackers. See [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) §3 and
[RUNBOOK.md](RUNBOOK.md) §1. _(Covers 3.1, 3.2.)_

**Authentication controls.** Argon2id password hashing; forced change
on first login; 5-attempt lockout; HttpOnly + Secure + SameSite=Strict
signed session cookies; 12-hour idle timeout; no "remember me" on
shared devices. See
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Authentication".
_(Covers 3.1, 3.4.)_

**Transport and storage security.** HTTPS only on the LAN; TLS 1.2
minimum, prefer 1.3; full-disk encryption at the VM level; daily
encrypted DB dumps; Phase 0 sign-off required a successful restore
drill (see [RUNBOOK.md](RUNBOOK.md) §10). _(Covers 3.1.)_

**Authorisation at service layer.** Pupils can only see their own
data; teachers can only see data for pupils in their classes. The
check lives in the service layer, not only the route layer, so a
misrouted request cannot bypass it. See
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Authorisation".
_(Covers 3.1, 3.4.)_

**Safeguarding flow.** A keyword-and-pattern flagger — deterministic,
not LLM — runs on every saved answer and surfaces concerning answers
at the top of the teacher moderation queue, with a "review and
follow safeguarding policy" banner. The pupil-facing UI does not
change in response, because that is a trained adult's role. The
flagger's keyword list is reviewed termly with the school's
safeguarding lead. See
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Safeguarding
flow". _(Covers 3.3.)_

**LLM-specific controls (Phase 3+).** Account configured for
zero data retention, verified against the current OpenAI terms before
Phase 3 begins and recorded in the audit log. Separate API keys per
environment, rotated termly. Per-class monthly spend cap with hard
cutoff. Kill switch: `LLM_ENABLED=false` disables all outbound LLM
calls, falling back to "your teacher will mark this". System prompt
isolation; pupil answer passed as a separate user-role chunk; marking
schema caps marks at the question's tariff. See
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"What is sent to
the LLM" and §"Prompt-injection and abuse". _(Covers 3.2, 3.5, 3.6.)_

**Pupil-facing honesty about AI.** Any AI-generated mark is labelled
"marked with AI assistance — your teacher will check". Pupils may
request human marking on any AI-marked response. Feedback is written
at a Year-10 reading level and is examiner-style, not sarcastic. See
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Pupil-facing
privacy notice" and [RISKS.md](RISKS.md) §4.1. _(Covers 3.2, 3.5.)_

**Rights paths tested.** Access, rectification, erasure, restriction,
portability, and objection each have a concrete operational answer
documented in [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)
§"Data subject rights". Erasure cascades through attempts, marks,
feedback, mastery state, and audit subject references. _(Covers 3.7.)_

**Audit trail.** An append-only `audit_events` table records logins,
submissions, overrides, and deletions. Pupil answer text is not
written to application logs; only ids and event types. Retention
matches §7 below.

## 5. The role of the LLM sub-processor

**Sub-processor.** OpenAI (API service). In use from Phase 3 onwards.
Not in use in Phases 0–2.

**What is sent.** Per [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)
§"What is sent to the LLM": the question stem and parts, the
teacher-authored mark scheme (mark points, accepted alternatives,
misconception list), the pupil's **redacted** answer, and a
pseudonymous attempt id. Not sent: pupil names, usernames, school
name, class name, session cookies, system credentials, or any other
pupil's data.

**Account configuration (precondition for Phase 3).**

- Zero data retention enabled at the API account level, confirmed in
  writing against the current OpenAI API terms and logged in the audit
  trail. Re-verified termly.
- Separate API keys for dev and prod; per-key spending cap; cost alerts
  configured; keys rotated at least per term; rotations logged in
  [RUNBOOK.md](RUNBOOK.md) §10.
- `LLM_ENABLED` environment flag gates all outbound calls. Flipping it
  to `false` and restarting the service must produce zero outbound
  HTTPS connections to `api.openai.com`; this is verified during Phase
  3 human testing.

**Cross-border transfer.** OpenAI processing involves a transfer of
pseudonymised pupil answer text to infrastructure outside the UK. The
school (as controller) relies on the published data processing
addendum from the sub-processor; the platform (as processor) records
the addendum version in use. Consent for AI marking is obtained from
parents via the parent-facing privacy notice before Phase 3 goes live
for their class, and pupils retain an opt-out that routes their open
responses to the teacher queue without any LLM call.

**What is not a sub-processor.** Hosting (school Proxmox), database
(on-VM Postgres), and backups (school's existing off-site regime) are
all in-house on school infrastructure. No third-party hosting provider
or managed database is involved.

## 6. Pupil and parent rights

Delivery of each UK GDPR right is defined in
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Data subject
rights". In summary:

| Right                                                           | Operational answer                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Access                                                          | Teacher exports the pupil's data as a JSON/CSV bundle from the admin UI.                                                                               |
| Rectification                                                   | Teacher can edit `display_name` and `pseudonym`. Pupil-authored answers are not edited — they are part of the assessment record.                       |
| Erasure                                                         | Teacher deletes the pupil. Cascade removes attempts, marks, feedback, mastery state, embeddings, and audit subject references. Anonymised counts stay. |
| Restriction                                                     | Per-pupil AI-marking opt-out routes all open responses to the teacher queue, with no LLM call.                                                         |
| Portability                                                     | The access bundle is the answer.                                                                                                                       |
| Objection                                                       | Per-pupil AI-marking opt-out, and/or full erasure.                                                                                                     |
| No solely-automated decisions with legal or significant effects | The platform does not make such decisions. A teacher is always in the loop for marks that contribute to any formal judgement.                          |

Pupil-facing notice (shown at first login, written for a Year-10
reader) and parent-facing notice (before AI marking is enabled for
their child's class) both live alongside this document; see
[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §"Pupil-facing
privacy notice".

Requests are handled within the school's standard response window
(default: one calendar month from receipt, extensible by two months
under Art. 12(3) if justified).

## 7. Retention periods

Mirrors [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)
§"Retention". A nightly retention job enforces these and is
idempotent.

| Data                                                   | Retention                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Pupil account + attempts + marks                       | While enrolled, plus up to 12 months. Then deleted unless the school has a documented reason to retain (e.g. appeal). |
| Anonymised aggregate analytics (counts, distributions) | Indefinite.                                                                                                           |
| Audit log                                              | 24 months minimum, then reviewed.                                                                                     |
| Application logs                                       | 30 days.                                                                                                              |
| Backups                                                | 35 daily backups, 12 monthly.                                                                                         |
| LLM call audit                                         | 12 months.                                                                                                            |

Backup copies under the school's existing regime follow the school's
standard retention; deletion from the live system will not retroactively
purge backups, in line with ICO guidance on backup deletion.

## 8. Sign-off

This DPIA becomes valid only once **both** signatures below are in
place. Until then, the platform must not process real pupil data.

### 8.1 Data Protection Officer

- Name: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Role: Data Protection Officer (school)
- Comments / required changes: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Signature: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Date: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***

### 8.2 Safeguarding lead (SLT)

- Name: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Role: Designated Safeguarding Lead / SLT link
- Comments / required changes: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Signature: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Date: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***

### 8.3 Processor (project owner)

- Name: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Role: Teacher, project owner and sole administrator of the
  application VM
- Signature: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***
- Date: **\*\***\*\***\*\***\_\_**\*\***\*\***\*\***

## Appendix A — Review history

| Date       | Author | Change                                                                                    |
| ---------- | ------ | ----------------------------------------------------------------------------------------- |
| 2026-04-16 | TD     | First draft at end of Phase 0. Not yet signed; awaiting DPO and safeguarding lead review. |

## Appendix B — Documents this DPIA relies on

- [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) — policy detail
  for data minimisation, authentication, LLM handling, rights, and
  retention.
- [RISKS.md](RISKS.md) — full risk register with likelihood/impact
  scoring.
- [DATA_MODEL.md](DATA_MODEL.md) — schema-level view of what is
  stored.
- [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) §3, §7 — hosting
  arrangements and required policy documents.
- [RUNBOOK.md](RUNBOOK.md) — operational procedures (backup/restore,
  secret rotation, incident response quick reference).
- [PLAN.md](PLAN.md) — phase-by-phase scope, which determines when new
  processing activities (notably LLM calls from Phase 3) begin.
