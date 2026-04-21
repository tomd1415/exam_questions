import type { PromptVersionRepo, PromptVersionRow } from '../repos/prompts.js';

// PromptVersionService owns the in-memory cache of the currently
// active prompt version per name. The cache is populated once at
// startup via loadActive() and is immutable until the next process
// restart — promoting a new prompt version is a deploy-time action
// (migration or seeder flips the row, service comes up fresh).
//
// There is no hot-reload path. A teacher-facing UI to flip active
// versions is explicitly deferred to Phase 3.1 after the pilot
// shows the eval harness is trustworthy enough to gate promotion
// automatically. Until then, the markdown body under
// prompts/<name>/<version>.md is the editable source and the DB
// row snapshots it at promotion time.

export class PromptVersionService {
  private activeByName: ReadonlyMap<string, PromptVersionRow> = new Map();
  private loaded = false;

  constructor(private readonly repo: PromptVersionRepo) {}

  // Called once during app bootstrap, after migrations have run.
  // Idempotent so tests can rebuild the app without re-instantiating
  // the service.
  async loadActive(): Promise<void> {
    const rows = await this.repo.listActive();
    const next = new Map<string, PromptVersionRow>();
    for (const row of rows) next.set(row.name, row);
    this.activeByName = next;
    this.loaded = true;
  }

  getActive(name: string): PromptVersionRow | null {
    if (!this.loaded) {
      throw new Error('PromptVersionService.getActive called before loadActive');
    }
    return this.activeByName.get(name) ?? null;
  }

  listActive(): readonly PromptVersionRow[] {
    if (!this.loaded) {
      throw new Error('PromptVersionService.listActive called before loadActive');
    }
    return Array.from(this.activeByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Admin read: all versions, including drafts and retired. Hits
  // the DB every call — this is only used by the admin page.
  async listAll(): Promise<PromptVersionRow[]> {
    return this.repo.listAll();
  }
}
