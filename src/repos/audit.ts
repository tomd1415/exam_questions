import type { Pool } from 'pg';
import type { UserRole } from './users.js';

export interface AuditEventInput {
  actorUserId: string | null;
  actorRole: UserRole | 'anonymous';
  subjectUserId: string | null;
  eventType: string;
  details: Record<string, unknown>;
}

export class AuditRepo {
  constructor(private readonly db: Pool) {}

  async append(event: AuditEventInput): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events
         (actor_user_id, actor_role, subject_user_id, event_type, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event.actorUserId,
        event.actorRole,
        event.subjectUserId,
        event.eventType,
        JSON.stringify(event.details),
      ],
    );
  }
}
