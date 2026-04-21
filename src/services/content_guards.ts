import type {
  ContentGuardKind,
  ContentGuardPatternInsert,
  ContentGuardPatternRow,
  ContentGuardRepo,
} from '../repos/content_guards.js';
import {
  SEED_PROMPT_INJECTION_PATTERNS,
  SEED_SAFEGUARDING_PATTERNS,
} from '../lib/content-guards.js';

// ContentGuardService caches the union of seeded patterns (compiled
// into the binary at src/lib/content-guards.ts) and the active
// admin-managed rows from the DB. The cache is refreshed at app
// boot and after every admin CRUD action; it is not hot-reloaded on
// a timer because the pattern set changes infrequently and stale
// reads during a single request are not a concern for us — the next
// request after an edit will see the new list.
//
// The safety gate (src/services/marking/safety-gate.ts) calls
// getPatterns(kind) synchronously on every mark, so the cache must
// have been populated via refresh() before any marking begins.
// App bootstrap enforces that ordering.

export class ContentGuardService {
  private safeguarding: readonly string[] = SEED_SAFEGUARDING_PATTERNS;
  private promptInjection: readonly string[] = SEED_PROMPT_INJECTION_PATTERNS;
  private loaded = false;

  constructor(private readonly repo: ContentGuardRepo) {}

  async refresh(): Promise<void> {
    const rows = await this.repo.listActive();
    const safeguarding = [...SEED_SAFEGUARDING_PATTERNS];
    const promptInjection = [...SEED_PROMPT_INJECTION_PATTERNS];
    for (const row of rows) {
      if (row.kind === 'safeguarding') safeguarding.push(row.pattern);
      else promptInjection.push(row.pattern);
    }
    this.safeguarding = safeguarding;
    this.promptInjection = promptInjection;
    this.loaded = true;
  }

  getPatterns(kind: ContentGuardKind): readonly string[] {
    if (!this.loaded) {
      throw new Error('ContentGuardService.getPatterns called before refresh');
    }
    return kind === 'safeguarding' ? this.safeguarding : this.promptInjection;
  }

  async listAll(): Promise<ContentGuardPatternRow[]> {
    return this.repo.listAll();
  }

  async add(input: ContentGuardPatternInsert): Promise<ContentGuardPatternRow> {
    const row = await this.repo.insert(input);
    await this.refresh();
    return row;
  }

  async setActive(id: string, active: boolean): Promise<ContentGuardPatternRow | null> {
    const row = await this.repo.setActive(id, active);
    if (row !== null) await this.refresh();
    return row;
  }

  async findById(id: string): Promise<ContentGuardPatternRow | null> {
    return this.repo.findById(id);
  }
}
