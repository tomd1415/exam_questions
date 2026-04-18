import type { Pool } from 'pg';

export type FeedbackStatus = 'new' | 'triaged' | 'in_progress' | 'resolved' | 'wontfix';
export type FeedbackCategory =
  | 'ui'
  | 'ux'
  | 'docs'
  | 'new_feature'
  | 'change_feature'
  | 'bug'
  | 'other';

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  'new',
  'triaged',
  'in_progress',
  'resolved',
  'wontfix',
] as const;

export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = [
  'ui',
  'ux',
  'docs',
  'new_feature',
  'change_feature',
  'bug',
  'other',
] as const;

export interface FeedbackRow {
  id: string;
  user_id: string;
  comment: string;
  submitted_at: Date;
  status: FeedbackStatus;
  category: FeedbackCategory | null;
  triage_notes: string | null;
  triaged_by: string | null;
  triaged_at: Date | null;
  resolved_at: Date | null;
}

export interface FeedbackWithAuthorRow extends FeedbackRow {
  author_username: string;
  author_display_name: string;
  author_role: string;
  triaged_by_display_name: string | null;
}

const SELECT_WITH_AUTHOR = `
  SELECT
    f.id::text,
    f.user_id::text,
    f.comment,
    f.submitted_at,
    f.status,
    f.category,
    f.triage_notes,
    f.triaged_by::text,
    f.triaged_at,
    f.resolved_at,
    u.username AS author_username,
    u.display_name AS author_display_name,
    u.role::text AS author_role,
    t.display_name AS triaged_by_display_name
  FROM pupil_feedback f
  JOIN users u ON u.id = f.user_id
  LEFT JOIN users t ON t.id = f.triaged_by
`;

export interface TriageInput {
  status: FeedbackStatus;
  category: FeedbackCategory | null;
  triageNotes: string | null;
  triagedBy: string;
}

export class FeedbackRepo {
  constructor(private readonly db: Pool) {}

  async create(input: { userId: string; comment: string }): Promise<FeedbackRow> {
    const { rows } = await this.db.query<FeedbackRow>(
      `INSERT INTO pupil_feedback (user_id, comment)
       VALUES ($1::bigint, $2)
       RETURNING
         id::text,
         user_id::text,
         comment,
         submitted_at,
         status,
         category,
         triage_notes,
         triaged_by::text,
         triaged_at,
         resolved_at`,
      [input.userId, input.comment],
    );
    return rows[0]!;
  }

  async findById(id: string): Promise<FeedbackWithAuthorRow | null> {
    const { rows } = await this.db.query<FeedbackWithAuthorRow>(
      `${SELECT_WITH_AUTHOR} WHERE f.id = $1::bigint`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listAll(): Promise<FeedbackWithAuthorRow[]> {
    const { rows } = await this.db.query<FeedbackWithAuthorRow>(
      `${SELECT_WITH_AUTHOR} ORDER BY f.submitted_at DESC, f.id DESC`,
    );
    return rows;
  }

  async listByUser(userId: string): Promise<FeedbackRow[]> {
    const { rows } = await this.db.query<FeedbackRow>(
      `SELECT
         id::text,
         user_id::text,
         comment,
         submitted_at,
         status,
         category,
         triage_notes,
         triaged_by::text,
         triaged_at,
         resolved_at
       FROM pupil_feedback
       WHERE user_id = $1::bigint
       ORDER BY submitted_at DESC, id DESC`,
      [userId],
    );
    return rows;
  }

  async triage(id: string, input: TriageInput): Promise<FeedbackRow | null> {
    const isResolvedLike = input.status === 'resolved' || input.status === 'wontfix';
    const { rows } = await this.db.query<FeedbackRow>(
      `UPDATE pupil_feedback
          SET status = $2,
              category = $3,
              triage_notes = $4,
              triaged_by = $5::bigint,
              triaged_at = now(),
              resolved_at = CASE WHEN $6 THEN now() ELSE NULL END
        WHERE id = $1::bigint
        RETURNING
          id::text,
          user_id::text,
          comment,
          submitted_at,
          status,
          category,
          triage_notes,
          triaged_by::text,
          triaged_at,
          resolved_at`,
      [id, input.status, input.category, input.triageNotes, input.triagedBy, isResolvedLike],
    );
    return rows[0] ?? null;
  }
}
