# Security and Privacy

This document is a working draft, not legal advice. It must be reviewed and signed off by the school's Data Protection Officer (DPO) and a member of SLT with safeguarding responsibility before any pupil data enters the live system.

The platform handles personal data of children under 16 in a UK school setting. UK GDPR, the Data Protection Act 2018, and statutory safeguarding guidance (KCSIE) all apply. The standard is therefore higher than for an adult-facing app.

## Roles under UK GDPR

- **Data controller:** the school. The platform is a tool used by a member of staff acting on the school's behalf.
- **Data processor:** the platform itself, hosted by the developer (the user, in their teacher capacity).
- **Sub-processors:** the OpenAI API (Phase 3+), the email sender (if used), and the embeddings provider (same as OpenAI in current plan). Hosting and backups are handled in-house on school infrastructure (Debian VM on the school Proxmox; school's existing backup regime), so no third-party hosting sub-processor is involved for the MVP.

A written processing arrangement between the developer and the school is required, even if the developer is a member of staff. Sub-processors must each have a published data processing addendum that the school can rely on.

## Lawful basis

- **Public task** (UK GDPR Art. 6(1)(e)) is the most appropriate basis for using the platform as part of a pupil's education at a state school.
- **Consent** is used additionally for the AI-marking feature: parents are informed and given a meaningful opt-out (objective-only marking + teacher-marked open responses).
- Processing of any special category data is avoided. The system does not collect SEND status, ethnicity, religion, or health data.

## Data Protection Impact Assessment (DPIA)

A DPIA is required before any pupil data is entered. The DPIA must cover at minimum:

1. The nature, scope, context, and purposes of processing.
2. Necessity and proportionality.
3. Risks to data subjects (pupils, including those under 13).
4. Measures to mitigate those risks.
5. The role of the LLM sub-processor and any data sent to it.
6. Pupil and parent rights (access, rectification, erasure, restriction).
7. Retention periods.
8. Sign-off by the DPO and the safeguarding lead.

The DPIA is a Phase 0 deliverable. If sign-off is delayed, Phase 1 may proceed only with synthetic/test data.

## Data minimisation

- No real names in AI-bound payloads. The redactor strips display names and known patterns; the `pseudonym` field is what the LLM ever sees.
- No DOB, contact details, address, or family information in the database.
- No pupil photos.
- No SEND, behaviour, or attendance flags.
- No free-text "notes" field on the pupil record.
- The minimum needed is: pseudonym, display name (for the teacher only), class membership, login credentials, and the pupil's own attempts and marks.

## Pupil-facing privacy notice (plain English)

A short notice shown at first login, written for a Year 10 reader. It says:

- What this site is for.
- That answers and marks are saved.
- That for some questions, answers may be sent to an external AI service for marking, with no name attached.
- That the pupil's teacher can see everything.
- That the pupil has the right to ask for their data to be corrected or removed.
- Who to talk to if they have questions.

A parent-facing version of the notice goes to families before the AI-marking feature is enabled in Phase 3.

## What is sent to the LLM

In Phase 3 onwards, the marking call sends:

- The question stem and parts.
- The mark scheme, mark points, accepted alternatives, and misconception list.
- The pupil's redacted answer.
- A pseudonymous attempt id (no user id, no display name).

It does not send:

- Pupil names, usernames, school name, class name, or any identifier that could re-identify them.
- Any other pupil's data.
- Cookies, sessions, or system credentials.

OpenAI API account is configured for zero data retention (verify against current API terms before Phase 3 begins, and document the verification in the audit log).

## Authentication

- Local accounts only. Pupils cannot self-register.
- Argon2id password hashing tuned to ~250ms on the production VM.
- Passwords stored as hashes only; never logged.
- Forced password change on first login.
- Lockout after 5 failed attempts for 15 minutes.
- Teachers can issue a one-time password reset; pupils cannot reset their own password without a teacher (no email-based reset for pupils, who often have no school email).
- Sessions: server-side, signed cookie, HttpOnly, Secure, SameSite=Strict, 12-hour idle timeout.
- No "remember me" on shared devices.
- No third-party SSO in Phase 1–6. Optional Google SSO in Phase 7 if the school formally requests it.

## Authorisation

- Pupils can only see their own data.
- Teachers can only see data for pupils in their classes.
- Admin role exists for the developer; not exposed in the UI.
- Every read and write of pupil data is checked at the service layer, not just at the route layer.

## Transport and storage security

- HTTPS only on the LAN. HTTP redirects to HTTPS. HSTS enabled with a sensible max-age.
- TLS approach captured in `RUNBOOK.md`: school internal CA, or Let's Encrypt via DNS-01 if a public DNS subdomain is delegated to the school. Renewals monitored.
- Database lives on the school's Proxmox-hosted Debian VM; full-disk encryption configured at the VM level. Pupil data never leaves the school network in normal operation.
- Backups: handled by the school's existing backup regime, which captures the application VM (or its DB dump location) on a daily cycle and ships an encrypted copy off-site. The DB-level `pg_dump` / `pg_restore` drill is owned by the application; the off-siting is owned by the school.
- Secrets stored in environment files readable only by the app user; included in the school's encrypted backup, separately from the data backup.
- No secrets ever committed to the repository.
- **Home access is out of scope for the MVP.** If introduced later, it triggers a DPIA addendum and a documented decision on reverse-proxy exposure vs VPN vs cloud frontend.

## Logging and audit

- Application logs are JSON, written to disk, rotated daily, retained 30 days.
- Pupil answer text is **not** included in application logs. Only ids and event types.
- LLM call audit (`llm_calls` table) records the redaction summary, not the redacted payload.
- The audit table records all teacher overrides and approvals.

## Safeguarding flow

Open answer boxes will at some point contain disclosures (self-harm, abuse, distress). The platform must surface these to the teacher and must not attempt to respond to the pupil through the AI feedback channel.

- A keyword and pattern flagger runs on every saved answer (deterministic, not LLM).
- Flagged answers appear at the top of the teacher's moderation queue with a clearly labelled "review and follow safeguarding policy" banner.
- The pupil-facing UI does not change in response to a flag (no "are you OK?" auto-message; this is the trained adult's role).
- The flagger's keyword list is reviewed termly with the safeguarding lead.

## Prompt-injection and abuse

Pupils will try prompt-injection. The system assumes this from day one.

- The pupil answer is always passed as a separate user-role chunk with a clear delimiter.
- The system prompt is fixed and never composed with pupil text.
- The marking schema constrains marks to `[0, marks_total]`. Out-of-range responses are clipped and the call is flagged.
- Suspicious patterns in pupil answers are flagged for teacher review rather than silently blocked, so we learn from them.
- Repeated, deliberate abuse routes the pupil to a teacher-only review state.

## Data subject rights

For each right, the operational answer:

- **Access:** the teacher can export a pupil's data as a JSON/CSV bundle from the admin UI.
- **Rectification:** teacher can edit the pupil's display name and pseudonym; pupil-authored answers are not edited (they are part of the assessment record).
- **Erasure:** teacher can delete a pupil. Cascade deletes attempts, marks, feedback, mastery state, embeddings, audit subject references. Aggregate anonymised counts are retained.
- **Restriction:** opt-out of AI marking sets a per-user flag that routes all open responses to the teacher queue without an LLM call.
- **Portability:** export bundle is the answer.
- **Objection:** opt-out of AI marking and/or full erasure.

Requests are handled within the school's standard response window.

## Retention

| Data | Retention |
| --- | --- |
| Pupil account + attempts + marks | While enrolled, plus up to 12 months. Then deleted unless the school has a documented reason to retain (e.g. appeal). |
| Anonymised aggregate analytics (counts, distributions) | Indefinite. |
| Audit log | 24 months minimum, then reviewed. |
| Application logs | 30 days. |
| Backups | 35 daily backups, 12 monthly. |
| LLM call audit | 12 months. |

A retention job runs nightly and is idempotent.

## Incident response

The user maintains a short incident-response checklist covering:

1. Detect and contain (rotate keys, disable accounts, take the app offline if needed).
2. Preserve evidence (snapshot DB, copy logs).
3. Notify the school's DPO immediately.
4. Assess whether a personal data breach has occurred and whether ICO notification is required (statutory 72-hour clock).
5. Inform affected pupils/parents in line with school policy.
6. Post-incident review: what failed, what changes follow.

## Accessibility (related to dignity, not strictly security)

- WCAG 2.2 AA target.
- Keyboard navigable; visible focus.
- Sufficient contrast; never rely on colour alone.
- Dyslexia-friendly font option.
- Adjustable text size and line spacing.
- Plain-English pupil feedback at Year 10 reading level.

## What changes if the platform expands beyond the user's school

If the platform is used by other schools, the data controller becomes each school. Each school requires:

- Its own DPIA.
- Its own data processing agreement.
- Its own pupil and parent privacy notices.
- Schema isolation via `class_id` is acceptable if schools are tenants of the same database; per-school export and erasure must remain straightforward.

This is out of scope before Phase 7.

## Documents that must exist before pupil go-live

- [ ] Signed DPIA.
- [ ] Pupil privacy notice (Year 10 reading level).
- [ ] Parent privacy notice (covers AI marking opt-out).
- [ ] Acceptable use statement.
- [ ] Safeguarding-flag review procedure agreed with the safeguarding lead.
- [ ] Sub-processor list with current addenda.
- [ ] Incident response checklist printed and pinned.
- [ ] Backup restore drill log entry (≥1).
