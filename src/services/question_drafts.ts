import type { UserRow } from '../repos/users.js';
import type {
  QuestionDraftRow,
  QuestionDraftPayload,
  QuestionDraftListRow,
} from '../repos/question_drafts.js';
import type { QuestionDraftRepo } from '../repos/question_drafts.js';
import type { QuestionService } from './questions.js';
import type { AuditService } from './audit.js';
import { QuestionInvariantError } from './questions.js';
import type { QuestionDraft } from '../lib/question-invariants.js';

export type ActorForDraft = Pick<UserRow, 'id' | 'role'>;

export class DraftAccessError extends Error {
  constructor(public readonly reason: 'not_teacher' | 'not_owner' | 'not_found') {
    super(`question draft access denied: ${reason}`);
    this.name = 'DraftAccessError';
  }
}

export class DraftStateError extends Error {
  constructor(
    public readonly reason: 'already_published' | 'incomplete_for_publish' | 'invalid_step',
  ) {
    super(`question draft state error: ${reason}`);
    this.name = 'DraftStateError';
  }
}

const MIN_STEP = 1;
const MAX_STEP = 9;
const PUBLISH_STEP = 9;

function canAuthor(actor: Pick<UserRow, 'role'>): boolean {
  return actor.role === 'teacher' || actor.role === 'admin';
}

function canRead(actor: ActorForDraft, row: QuestionDraftRow): boolean {
  if (actor.role === 'admin') return true;
  return row.author_user_id === actor.id;
}

// Merges step output into the accumulated payload. Replaces top-level keys
// the step touched, leaves untouched keys alone. `parts` is treated as a
// whole-array replacement (not a per-element merge) because each step that
// writes parts knows the full intended array — step 4 writes the part
// shells, step 6 rewrites them with marks/mark_points, step 7 with
// misconceptions. A future "resume mid-step" feature might need a smarter
// merge, but for the wizard's linear flow this is correct and simple.
function mergePayload(
  current: QuestionDraftPayload,
  patch: QuestionDraftPayload,
): QuestionDraftPayload {
  return { ...current, ...patch };
}

// Hardens the accumulated payload into the full-fat QuestionDraft shape
// QuestionService.createDraft expects. Anything missing throws — the caller
// has already gated this on current_step === 9, so a missing field here is
// a bug, not user input.
function payloadToDraft(payload: QuestionDraftPayload): QuestionDraft {
  const required = (
    [
      'component_code',
      'topic_code',
      'subtopic_code',
      'command_word_code',
      'archetype_code',
      'stem',
      'expected_response_type',
      'model_answer',
      'difficulty_band',
      'difficulty_step',
      'source_type',
      'parts',
    ] as const
  ).filter((k) => payload[k] === undefined || payload[k] === null);
  if (required.length > 0) {
    throw new DraftStateError('incomplete_for_publish');
  }
  return {
    component_code: payload.component_code!,
    topic_code: payload.topic_code!,
    subtopic_code: payload.subtopic_code!,
    command_word_code: payload.command_word_code!,
    archetype_code: payload.archetype_code!,
    stem: payload.stem!,
    expected_response_type: payload.expected_response_type!,
    model_answer: payload.model_answer!,
    feedback_template: payload.feedback_template ?? null,
    difficulty_band: payload.difficulty_band!,
    difficulty_step: payload.difficulty_step!,
    source_type: payload.source_type!,
    review_notes: payload.review_notes ?? null,
    parts: payload.parts!,
  };
}

export class QuestionDraftService {
  constructor(
    private readonly repo: QuestionDraftRepo,
    private readonly questions: QuestionService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: ActorForDraft): Promise<string> {
    if (!canAuthor(actor)) throw new DraftAccessError('not_teacher');
    const id = await this.repo.create(actor.id);
    await this.audit.record({ userId: actor.id, role: actor.role }, 'question.draft.created', {
      draft_id: id,
    });
    return id;
  }

  async findForActor(actor: ActorForDraft, draftId: string): Promise<QuestionDraftRow> {
    if (!canAuthor(actor)) throw new DraftAccessError('not_teacher');
    const row = await this.repo.findById(draftId);
    if (!row) throw new DraftAccessError('not_found');
    if (!canRead(actor, row)) throw new DraftAccessError('not_owner');
    return row;
  }

  async listForActor(actor: ActorForDraft): Promise<QuestionDraftListRow[]> {
    if (!canAuthor(actor)) throw new DraftAccessError('not_teacher');
    return this.repo.listByAuthor(actor.id);
  }

  // Records the teacher's answer for `step`, merges it into the payload,
  // and bumps current_step to max(current_step, step + 1) so the next
  // visit lands on the next unanswered step. Step 9's "advance" is
  // publish — call publish() instead.
  async advance(
    actor: ActorForDraft,
    draftId: string,
    step: number,
    patch: QuestionDraftPayload,
  ): Promise<QuestionDraftRow> {
    if (step < MIN_STEP || step > MAX_STEP || !Number.isInteger(step)) {
      throw new DraftStateError('invalid_step');
    }
    const row = await this.findForActor(actor, draftId);
    if (row.published_question_id !== null) {
      throw new DraftStateError('already_published');
    }

    const merged = mergePayload(row.payload, patch);
    const nextStep = Math.min(MAX_STEP, Math.max(row.current_step, step + 1));
    await this.repo.update(draftId, { current_step: nextStep, payload: merged });

    await this.audit.record({ userId: actor.id, role: actor.role }, 'question.draft.advanced', {
      draft_id: draftId,
      step,
      widget_type: merged.expected_response_type ?? null,
    });

    return {
      ...row,
      current_step: nextStep,
      payload: merged,
    };
  }

  // Hands the accumulated payload to QuestionService.createDraft so the
  // wizard shares the exact insert path the seeder uses (and the existing
  // /admin/questions form). On success the draft row is locked and the
  // caller redirects to the live question's admin page.
  async publish(actor: ActorForDraft, draftId: string): Promise<{ questionId: string }> {
    const row = await this.findForActor(actor, draftId);
    if (row.published_question_id !== null) {
      throw new DraftStateError('already_published');
    }
    if (row.current_step < PUBLISH_STEP) {
      throw new DraftStateError('incomplete_for_publish');
    }

    let draft: QuestionDraft;
    try {
      draft = payloadToDraft(row.payload);
    } catch (err) {
      if (err instanceof DraftStateError) throw err;
      throw new DraftStateError('incomplete_for_publish');
    }

    let questionId: string;
    try {
      questionId = await this.questions.createDraft(actor, draft);
    } catch (err) {
      if (err instanceof QuestionInvariantError) throw err;
      throw err;
    }

    await this.repo.markPublished(draftId, questionId);
    await this.audit.record({ userId: actor.id, role: actor.role }, 'question.draft.published', {
      draft_id: draftId,
      question_id: questionId,
    });

    return { questionId };
  }
}
