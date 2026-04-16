import type { UserRow } from '../repos/users.js';
import type { QuestionRepo, ApprovalStatus } from '../repos/questions.js';
import type { CurriculumRepo } from '../repos/curriculum.js';
import type { AuditService } from './audit.js';
import {
  canTransition,
  validateQuestionDraft,
  type InvariantIssue,
  type QuestionDraft,
} from '../lib/question-invariants.js';

export type ActorForQuestion = Pick<UserRow, 'id' | 'role'>;

export class QuestionAccessError extends Error {
  constructor(public readonly reason: 'not_teacher' | 'not_owner' | 'not_found') {
    super(`question access denied: ${reason}`);
    this.name = 'QuestionAccessError';
  }
}

export class QuestionInvariantError extends Error {
  constructor(public readonly issues: InvariantIssue[]) {
    super(`question invariants violated (${issues.length})`);
    this.name = 'QuestionInvariantError';
  }
}

export class ApprovalTransitionError extends Error {
  constructor(
    public readonly from: ApprovalStatus,
    public readonly to: ApprovalStatus,
  ) {
    super(`approval transition not allowed: ${from} → ${to}`);
    this.name = 'ApprovalTransitionError';
  }
}

function canManage(actor: Pick<UserRow, 'role'>): boolean {
  return actor.role === 'teacher' || actor.role === 'admin';
}

function ownsOrAdmin(actor: ActorForQuestion, createdBy: string): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'teacher') return false;
  return createdBy === actor.id;
}

export class QuestionService {
  constructor(
    private readonly repo: QuestionRepo,
    private readonly curriculum: CurriculumRepo,
    private readonly audit: AuditService,
  ) {}

  async createDraft(actor: ActorForQuestion, draft: QuestionDraft): Promise<string> {
    if (!canManage(actor)) throw new QuestionAccessError('not_teacher');
    const refs = await this.curriculum.getReferenceData();
    const result = validateQuestionDraft(draft, refs);
    if (!result.ok) throw new QuestionInvariantError(result.issues);

    const id = await this.repo.createWithChildren({ ...result.value, created_by: actor.id });
    await this.audit.record({ userId: actor.id, role: actor.role }, 'question.created', {
      question_id: id,
      topic_code: result.value.topic_code,
      subtopic_code: result.value.subtopic_code,
      marks_total: result.value.marks_total,
    });
    return id;
  }

  async updateDraft(
    actor: ActorForQuestion,
    questionId: string,
    draft: QuestionDraft,
  ): Promise<void> {
    if (!canManage(actor)) throw new QuestionAccessError('not_teacher');
    const meta = await this.repo.findApprovalMeta(questionId);
    if (!meta) throw new QuestionAccessError('not_found');
    if (!ownsOrAdmin(actor, meta.created_by)) throw new QuestionAccessError('not_owner');

    const refs = await this.curriculum.getReferenceData();
    const result = validateQuestionDraft(draft, refs);
    if (!result.ok) throw new QuestionInvariantError(result.issues);

    await this.repo.updateWithChildren(questionId, {
      ...result.value,
      created_by: meta.created_by,
    });
    await this.audit.record({ userId: actor.id, role: actor.role }, 'question.updated', {
      question_id: questionId,
      approval_status_before: meta.approval_status,
      marks_total: result.value.marks_total,
    });
  }

  async setApprovalStatus(
    actor: ActorForQuestion,
    questionId: string,
    next: ApprovalStatus,
    reviewNotes: string | null = null,
  ): Promise<void> {
    if (!canManage(actor)) throw new QuestionAccessError('not_teacher');
    const meta = await this.repo.findApprovalMeta(questionId);
    if (!meta) throw new QuestionAccessError('not_found');
    if (!ownsOrAdmin(actor, meta.created_by)) throw new QuestionAccessError('not_owner');

    if (!canTransition(meta.approval_status, next))
      throw new ApprovalTransitionError(meta.approval_status, next);

    const active = next === 'approved';
    const approvedBy = next === 'approved' ? actor.id : null;
    const notes = next === 'rejected' ? (reviewNotes ?? '').trim() : null;
    if (next === 'rejected' && (notes === null || notes.length === 0))
      throw new QuestionInvariantError([
        { path: 'review_notes', message: 'A reject reason is required.' },
      ]);

    await this.repo.setApprovalStatus(questionId, {
      approval_status: next,
      approved_by: approvedBy,
      active,
      review_notes: notes,
    });

    const eventType =
      next === 'approved'
        ? 'question.approved'
        : next === 'rejected'
          ? 'question.rejected'
          : 'question.status_changed';
    await this.audit.record({ userId: actor.id, role: actor.role }, eventType, {
      question_id: questionId,
      from: meta.approval_status,
      to: next,
      ...(notes ? { review_notes: notes } : {}),
    });
  }
}
