import type { UserRow } from '../repos/users.js';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackRepo,
  type FeedbackRow,
  type FeedbackStatus,
  type FeedbackWithAuthorRow,
  type TriageInput,
} from '../repos/feedback.js';
import type { AuditService } from './audit.js';

export type ActorForFeedback = Pick<UserRow, 'id' | 'role'>;

export class FeedbackError extends Error {
  constructor(
    public readonly reason:
      | 'empty_comment'
      | 'comment_too_long'
      | 'not_found'
      | 'forbidden'
      | 'invalid_status'
      | 'invalid_category'
      | 'notes_too_long',
  ) {
    super(`feedback error: ${reason}`);
    this.name = 'FeedbackError';
  }
}

const COMMENT_MAX = 2000;
const NOTES_MAX = 2000;

function canTriage(actor: ActorForFeedback): boolean {
  return actor.role === 'teacher' || actor.role === 'admin';
}

export interface SubmitFeedbackInput {
  comment: string;
}

export interface TriageFeedbackInput {
  status: string;
  category: string | null;
  triageNotes: string | null;
}

export class FeedbackService {
  constructor(
    private readonly repo: FeedbackRepo,
    private readonly audit: AuditService,
  ) {}

  async submit(actor: ActorForFeedback, input: SubmitFeedbackInput): Promise<FeedbackRow> {
    const comment = input.comment.trim();
    if (comment.length === 0) throw new FeedbackError('empty_comment');
    if (comment.length > COMMENT_MAX) throw new FeedbackError('comment_too_long');

    const row = await this.repo.create({ userId: actor.id, comment });
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'feedback.submitted',
      { feedback_id: row.id, comment_length: comment.length },
      actor.id,
    );
    return row;
  }

  async listAll(actor: ActorForFeedback): Promise<FeedbackWithAuthorRow[]> {
    if (!canTriage(actor)) throw new FeedbackError('forbidden');
    return this.repo.listAll();
  }

  async listMine(actor: ActorForFeedback): Promise<FeedbackRow[]> {
    return this.repo.listByUser(actor.id);
  }

  async triage(
    actor: ActorForFeedback,
    feedbackId: string,
    input: TriageFeedbackInput,
  ): Promise<FeedbackRow> {
    if (!canTriage(actor)) throw new FeedbackError('forbidden');

    if (!FEEDBACK_STATUSES.includes(input.status as FeedbackStatus)) {
      throw new FeedbackError('invalid_status');
    }
    const status = input.status as FeedbackStatus;

    let category: FeedbackCategory | null = null;
    if (input.category !== null && input.category !== '') {
      if (!FEEDBACK_CATEGORIES.includes(input.category as FeedbackCategory)) {
        throw new FeedbackError('invalid_category');
      }
      category = input.category as FeedbackCategory;
    }

    let notes: string | null = null;
    if (input.triageNotes !== null) {
      const trimmed = input.triageNotes.trim();
      if (trimmed.length > NOTES_MAX) throw new FeedbackError('notes_too_long');
      notes = trimmed.length === 0 ? null : trimmed;
    }

    const triageInput: TriageInput = {
      status,
      category,
      triageNotes: notes,
      triagedBy: actor.id,
    };
    const updated = await this.repo.triage(feedbackId, triageInput);
    if (!updated) throw new FeedbackError('not_found');

    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'feedback.triaged',
      {
        feedback_id: updated.id,
        status: updated.status,
        category: updated.category,
      },
      updated.user_id,
    );
    return updated;
  }
}
