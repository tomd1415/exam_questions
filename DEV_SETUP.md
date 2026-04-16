# Development Setup

Target dev environment: **Gentoo Linux** with VSCode. Target production environment: **Debian Linux** server. The dev environment runs Postgres in Docker so the Gentoo ↔ Debian difference is contained to the OS-level tooling (systemd, nginx) and not the database.

This document is the single source of truth for getting a working dev loop on this project. If it falls out of date, fix it in the same change.

## Prerequisites

Already confirmed on this machine at setup time:

| Tool | Minimum | This machine |
| --- | --- | --- |
| Node.js | 22 LTS | 24 (works; `.nvmrc` targets 22 for parity with Debian deploy) |
| npm | 10 | 11 |
| Docker | 24 | 28 |
| Docker Compose | v2 | v2.39 |
| PostgreSQL client (`psql`) | 15 | 18 (system; dev DB runs in Docker) |
| git | 2.40 | 2.52 |
| VSCode | 1.90 | 1.115 |

If any of these are missing on a new machine, install via the Gentoo package manager (`emerge`) before proceeding.

## One-time setup

### 1. Clone and open

```bash
git clone git@github.com:tomd1415/exam_questions.git
cd exam_questions
code .
```

On first open, VSCode will prompt to install the workspace-recommended extensions listed in [.vscode/extensions.json](.vscode/extensions.json). Accept.

### 2. Environment file

```bash
cp .env.example .env
# Generate a real session secret:
sed -i "s|replace_with_a_long_random_hex_string_for_local_dev_only|$(openssl rand -hex 32)|" .env
```

Never commit `.env`. The [.gitignore](.gitignore) already excludes it.

### 3. Node dependencies

```bash
npm install
```

This installs TypeScript, the ESLint/Prettier toolchain, Vitest, `pg`, `zod`, and `dotenv`. Framework libraries (Fastify, templating, etc.) are **not** installed yet — they come in during Phase 0 so the dependency list reflects what has actually been wired up.

### 4. Database

The dev database is Postgres 16 with the `pgvector` extension pre-enabled, running in Docker on host port `5433` (port 5432 is left free for your system Postgres).

```bash
npm run db:up        # starts the container
npm run db:psql      # opens psql inside the container (once it's up)
```

Extensions enabled on first init: `vector`, `pg_trgm`, `citext`. See [scripts/db-init.sh](scripts/db-init.sh).

Useful variations:

| Command | Purpose |
| --- | --- |
| `npm run db:down` | stop the container (data persists) |
| `npm run db:reset` | stop and **wipe** the volume, then recreate (runs `db-init.sh` again) |
| `npm run db:logs` | tail the container logs |

## Daily workflow

### Start everything

From VSCode, press `Ctrl+Shift+B` (the default build task) to run **dev: start everything**, which brings Postgres up and then starts the app in watch mode.

Or, in a terminal:

```bash
npm run db:up
npm run dev
```

`npm run dev` uses [tsx](https://tsx.is/) to run `src/index.ts` directly with hot reload on file change. No build step is needed in dev.

### Lint, format, type-check, test

```bash
npm run typecheck       # tsc --noEmit, strict mode
npm run lint            # eslint flat config
npm run format          # prettier --write
npm run test            # vitest run
npm run check           # all four, fail on the first problem
```

`npm run check` is what CI will run. Make it pass locally before pushing.

### Debugging in VSCode

[.vscode/launch.json](.vscode/launch.json) ships three launch configs:

- **Dev: run src/index.ts (tsx)** — runs `npm run dev` under the debugger; breakpoints work.
- **Test: run current Vitest file** — runs the active test file under the debugger.
- **Test: run all Vitest** — runs the whole test suite under the debugger.

### Database browsing

The SQLTools extension is pre-configured in [.vscode/settings.json](.vscode/settings.json) with a connection named **exam_dev (docker)**. Open the SQLTools view, click the connection, authenticate (password `exam` in dev only), and you can run queries inside VSCode.

Alternative: `npm run db:psql` drops you into a psql shell inside the container.

## What's in the dev environment

### Files at the project root

| File | Purpose |
| --- | --- |
| [package.json](package.json) | npm scripts + dependency pins |
| [tsconfig.json](tsconfig.json) | strict TypeScript config used by editor + tests |
| [tsconfig.build.json](tsconfig.build.json) | build-only config (excludes tests, drops sourcemaps) |
| [eslint.config.js](eslint.config.js) | ESLint flat config with the type-checked rule set |
| [.prettierrc.json](.prettierrc.json) | Prettier rules (100-col, single quote, trailing commas) |
| [.editorconfig](.editorconfig) | editor-agnostic formatting (LF, 2 spaces, UTF-8) |
| [.nvmrc](.nvmrc) | Node version pin (22) |
| [.env.example](.env.example) | template for `.env` |
| [docker-compose.yml](docker-compose.yml) | Postgres 16 + pgvector for dev |
| [scripts/db-init.sh](scripts/db-init.sh) | first-run SQL to enable extensions |
| [.dockerignore](.dockerignore) | keeps OCR_Docs and secrets out of future Docker builds |

### .vscode/ (shared across contributors)

| File | Purpose |
| --- | --- |
| [.vscode/extensions.json](.vscode/extensions.json) | recommended extensions for this project |
| [.vscode/settings.json](.vscode/settings.json) | format-on-save, ESLint flat config, cSpell words, markdownlint rules, SQLTools connection |
| [.vscode/launch.json](.vscode/launch.json) | debug configurations |
| [.vscode/tasks.json](.vscode/tasks.json) | build task `Ctrl+Shift+B`, db helpers, full-checks task |

Per-user `.vscode/` files (history, local overrides) are gitignored; the four files above are the only ones tracked.

### Recommended VSCode extensions

All in [.vscode/extensions.json](.vscode/extensions.json). The opinionated few:

- **ESLint + Prettier + EditorConfig** — code formatting and linting in the editor.
- **Pretty TypeScript Errors** — readable TS errors.
- **Vitest Explorer** — run/debug tests from the test explorer.
- **SQLTools + SQLTools PG driver** — browse Postgres from inside VSCode.
- **Containers (Microsoft)** — manage the dev Postgres container.
- **markdownlint** — keeps the planning docs tidy (rules tuned in settings).
- **Code Spell Checker** — project vocabulary pre-loaded (OCR, GCSE, DPIA, HTMX, pgvector, etc.).
- **dotenv** — `.env` syntax highlighting.
- **GitLens** — inline blame and history.
- **Markdown Mermaid** — preview Mermaid diagrams inside Markdown.

## Production differences (Debian target)

The Debian server will not run Docker for the database in production. Instead:

- Install Postgres 16 natively (`apt install postgresql-16 postgresql-16-pgvector`).
- Run the app under a systemd unit as a non-root user.
- Reverse-proxy via nginx or Caddy, terminating TLS with Let's Encrypt.
- Back up with pg_dump to an off-server encrypted location (see [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)).

Nothing in the dev config depends on Docker at runtime; only the database lives in a container locally. Code written for dev runs unchanged against a native Debian Postgres as long as `DATABASE_URL` is pointed at it.

See [RESOURCES_REQUIRED.md](RESOURCES_REQUIRED.md) for the full provisioning list and the Phase 0 checklist.

## Troubleshooting

### Postgres won't start

- Check if port 5433 is already in use: `ss -ltnp | grep 5433`.
- Inspect logs: `npm run db:logs`.
- Wipe and recreate: `npm run db:reset` (destroys all dev data).

### ESLint is slow or hanging

The type-checked ruleset does real TypeScript compilation. If it gets too slow:

- Ensure the SQLTools connection isn't opening on every save (it shouldn't, but worth checking).
- Consider switching `eslint.run` from `onType` to `onSave` in your **User** settings (not the committed workspace settings).

### TypeScript complains about Node built-ins

Make sure `@types/node` is installed (`npm install`) and that VSCode is using the workspace TypeScript: cmd-palette → "TypeScript: Select TypeScript Version..." → "Use Workspace Version".

### Tests can't find modules

Vitest resolves modules via the same TypeScript config as the app. If an import breaks in tests but works in dev, re-check `tsconfig.json` paths and extensions (`moduleResolution: "NodeNext"` requires explicit `.js` suffixes on relative imports from `.ts` files).

## When to update this document

- A new dev dependency is added that needs explanation (not every routine bump).
- A new npm script is introduced.
- The database port, user, or extensions change.
- A new VSCode workspace setting or task is committed.
- Phase 0/1 work exposes a setup gotcha worth capturing.

If a section is no longer accurate, **delete or rewrite it** rather than leaving a stale note.
