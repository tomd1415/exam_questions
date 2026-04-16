# Resources Required

Everything needed to design, build, run, and operate this project. Grouped by type. Estimated costs are in GBP and based on rates current at planning time (2026-04). Re-check before purchase.

## 1. People and time

| Role | Phase(s) | Estimate |
| --- | --- | --- |
| Lead developer / project owner (you) | All | ~6–10 hrs/week, term-time-friendly |
| Reviewer for question content | 1, 5 | A second CS teacher able to spend ~1 hr/week |
| Pupil testers | 1 onwards | One teaching class, with parental consent for testing AI features in Phase 3+ |
| DPO / SLT signoff for DPIA | 0 | One meeting, plus follow-up |
| School IT contact | 0, 1, 7 | Brief consultation about network access and device compatibility |

The single hardest resource is your own evening time. Phases are sized so any one of them can be paused at a half-term boundary.

## 2. Hardware

| Item | Purpose | Notes |
| --- | --- | --- |
| Development machine | Your own | Linux (you already use Gentoo). 16+ GB RAM comfortable. |
| Server | Production hosting | Single small VPS sufficient for one school. See §3. |
| Backup destination | Off-server backups | Object storage (e.g. Backblaze B2, Hetzner Storage Box) in UK/EU. |
| Test devices | Realistic compatibility | Borrow at least: a school Chromebook, a school Windows laptop, an iPad. Test on each before Phase 1 user testing. |

## 3. Hosting and infrastructure

| Service | Purpose | Indicative monthly cost (GBP) |
| --- | --- | --- |
| Small VPS (UK/EU region, ~2 vCPU / 4 GB RAM / 80 GB SSD) | App + Postgres in one box for MVP | £8–£15 |
| Domain name | Stable URL the school can whitelist | £10–£15 / year |
| Off-server backups (encrypted) | Daily DB dumps + asset bundle | £1–£3 |
| TLS certificate | HTTPS | Free via Let's Encrypt |
| Email sender (transactional) | Account creation, password reset, alerts | £0 on a small free tier; budget £5 if it grows |
| Monitoring/uptime ping | "Is it up at 9am?" alert | £0–£5 |

UK/EU region is non-negotiable for pupil data hosting per [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md).

## 4. Third-party APIs

### OpenAI

| Use | Model tier (planned) | Notes |
| --- | --- | --- |
| Marking (Phase 3) | A capable mid-tier model; escalate to a stronger model on low confidence | Use Responses API + Structured Outputs |
| Question generation (Phase 5) | A stronger reasoning-capable model | Lower volume, higher per-call cost |
| Embeddings (Phase 5/6) | `text-embedding-3-small` | Cheap; used for duplicate detection and clustering |

**Account configuration before any pupil data flows:**
- Zero data retention setting enabled (verify against current API terms; this is standard for API customers but must be confirmed in writing).
- Per-key spending limit and alerts configured.
- Separate API keys per environment (dev / prod), rotated at least per term.

**Cost budgeting (rough):**
- Marking budget target: ≤£0.05 per pupil per week in steady use.
- Generation budget: small batch each half-term, target ≤£10 per batch.
- Set hard monthly cap; system stops calling the API and surfaces the cap to the teacher.

Costs change. Reconfirm pricing for the chosen models when configuring the account, and again at the start of each phase that uses them.

**Reference: OpenAI Documentation MCP server.**
OpenAI publish their API documentation as a Model Context Protocol server at <https://developers.openai.com/mcp>. Configure this MCP in the development environment (Claude Code, Cursor, etc.) so prompts, schemas, and pricing references are checked against the *current* docs rather than against whatever the model was trained on. This is the canonical source for:

- Responses API surface and parameters.
- Structured Outputs schema rules and JSON-Schema dialect support.
- Model availability, pricing, and rate limits.
- Embeddings model details.
- Zero-data-retention and enterprise privacy terms.

Use it whenever a phase that touches the API (Phase 3, 5, 6) is being designed or revised.

### Other potential services (later)

| Service | Purpose | Phase |
| --- | --- | --- |
| Sentry or similar error tracking | Production error visibility | 3+ |
| Cloudflare (free tier) | DNS + basic DDoS shield | 1+ |

## 5. Software dependencies

Open-source unless stated otherwise.

| Layer | Choice | Purpose |
| --- | --- | --- |
| Runtime | Node.js LTS | Server runtime |
| Language | TypeScript | Strong types for LLM JSON schemas |
| Web framework | Fastify | Small, fast, good schema support |
| Templating | Eta or similar server-side templates | Server-rendered HTML |
| Frontend | HTMX, vanilla JS, Tailwind (or hand-written CSS) | Works on locked-down devices |
| Database | PostgreSQL with `pgvector` extension | Relational + vector |
| Migrations | `node-pg-migrate` or `drizzle-kit` | Versioned schema |
| Auth | Custom local accounts; Argon2 (`@node-rs/argon2`) | Passwords |
| Validation | Zod | Request validation + LLM schema validation |
| Background jobs (Phase 4+) | BullMQ on Redis | Calibration jobs, embeddings batches |
| Testing | Vitest + Playwright | Unit + end-to-end |
| Linting | ESLint, Prettier | House style |
| Process supervision | systemd unit on the VPS | Restart on crash |

## 6. Content resources

The platform's accuracy depends on the quality of the curriculum and question content underneath the LLM.

| Resource | Source | Purpose |
| --- | --- | --- |
| OCR J277 specification | Official OCR | Source of truth for topics, subtopics, command words, assessment objectives |
| OCR J277 past papers | Official OCR | Pattern source for question styles and tariffs (not for verbatim use) |
| OCR J277 mark schemes | Official OCR | Source for mark-point granularity, accepted alternatives, marking conventions |
| OCR examiner reports | Official OCR | Source for misconception library and feedback phrasing |
| Hand-curated question bank | Authored by you (and a colleague) | Seed bank of 60–100 questions for Phase 1 |
| OCR command words list | Official OCR teacher support material | Reference for question generation prompts |

Storage rules:
- Spec, papers, mark schemes, examiner reports kept in a `content/source/` folder, gitignored, never deployed to the pupil-facing app.
- Only derived structures (topic codes, command-word definitions, mark-point patterns) enter the database.
- Generated questions are never near-duplicates of source paper text (see [RISKS.md](RISKS.md) §2.2).

## 7. Documentation and policy

| Document | Owner | Phase |
| --- | --- | --- |
| Data Protection Impact Assessment (DPIA) | You, signed off by school DPO/SLT | 0 |
| Privacy notice (pupil and parent versions) | You | 0 |
| Acceptable use statement | You | 0 |
| Safeguarding flowchart for AI-flagged content | You + safeguarding lead | 1 |
| Operational runbook | You | 7 |
| Prompt change log | You | 3+ |
| Incident response checklist | You | 3+ |

## 8. Skills and knowledge to acquire (if not already held)

- OCR J277 specification at the level of fluently mapping any past-paper question to its topic and command word. (Already held by the user.)
- Prompt engineering for structured outputs and rubric-grounded marking. New for Phase 3.
- Postgres `pgvector` basics for similarity search. New for Phase 5.
- Basic Linux server administration: systemd, nginx/Caddy, Let's Encrypt, backup scripting.
- UK GDPR fundamentals as they apply to under-16s in education settings.

## 9. Recurring operational checklist (once live)

| Cadence | Task |
| --- | --- |
| Daily | Backup ran (alert on failure) |
| Weekly | Skim moderation queue and prompt-injection flags |
| Half-termly | Run a backup restore drill; review API costs vs budget |
| Termly | Rotate API keys; review and update DPIA if anything changed |
| Annually | Renew domain, review hosting plan, full security review |

## 10. Initial purchase / setup checklist

Before Phase 0 ends, the following must exist and be paid for:

- [ ] VPS provisioned in UK/EU region.
- [ ] Domain registered.
- [ ] Backup destination account.
- [ ] OpenAI account with billing limit, separate dev key, zero-retention configured.
- [ ] Email sender account.
- [ ] Calendar reminders set for renewals and key rotation.
- [ ] Repository created with branch protection on `main`.
- [ ] Secrets vault chosen (even a `.env` file with restricted permissions plus an encrypted backup is acceptable for a single-person project).

## 11. Things deliberately not on this list

- A second server / high-availability pair. Not needed at one-school scale; revisit in Phase 7.
- A managed Postgres service. The cost is hard to justify at this scale; a well-backed-up self-hosted Postgres is fine.
- A separate vector database. `pgvector` is sufficient until proven otherwise.
- A CDN. Pupil traffic is small and predictable.
- Mobile apps. The web app must work in mobile browsers; native apps are out of scope.
