import type { AuditRepo } from '../repos/audit.js';
import type { UserRole } from '../repos/users.js';

export interface ActorContext {
  userId: string | null;
  role: UserRole | 'anonymous';
}

export class AuditService {
  constructor(private readonly repo: AuditRepo) {}

  async record(
    actor: ActorContext,
    eventType: string,
    details: Record<string, unknown> = {},
    subjectUserId: string | null = null,
  ): Promise<void> {
    await this.repo.append({
      actorUserId: actor.userId,
      actorRole: actor.role,
      subjectUserId,
      eventType,
      details,
    });
  }
}
