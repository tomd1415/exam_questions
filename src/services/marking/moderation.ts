import type { AttemptRepo, ModerationDetailRow, ModerationQueueRow } from '../../repos/attempts.js';
import type { UserRow } from '../../repos/users.js';
import type { AuditService } from '../audit.js';

// ModerationService is the admin-only surface for the AI-flagged
// moderation queue (chunk 3d). The LLM dispatch writes
// moderation_status='pending' when the safety gate fires; this
// service lists those rows, renders detail, and lets an admin
// accept them unchanged or override them with a new mark.
//
// Admin-only for Phase 3: teachers see their own class's
// teacher-pending parts via the existing TeacherMarkingService;
// AI-flagged items need sole-admin review because the failure modes
// (prompt injection, safeguarding hits) are not class-level concerns.
// A future split could surface the teacher's class rows to that
// teacher, but the acceptance UI stays admin-only until we have a
// policy for who can sign off on "accept the model's mark".

export class ModerationError extends Error {
  constructor(
    public readonly reason:
      | 'not_admin'
      | 'not_found'
      | 'already_resolved'
      | 'invalid_marks'
      | 'invalid_reason'
      | 'no_change',
  ) {
    super(`moderation denied: ${reason}`);
    this.name = 'ModerationError';
  }
}

export type ActorForModeration = Pick<UserRow, 'id' | 'role'>;

export interface OverrideAiMarkInput {
  awardedMarkId: string;
  marksAwarded: number;
  reason: string;
}

// Chunk 3i. Pilot-shadow review uses the same shape as an override
// but is semantically different — the teacher is recording their own
// mark alongside the AI's, even when they agree. That agreement is
// the load-bearing signal for the ±1 mark accuracy calculation in
// PHASE3_PLAN.md §5 chunk 3i exit criteria.
export interface PilotShadowReviewInput {
  awardedMarkId: string;
  teacherMarksAwarded: number;
  reason: string;
}

export class ModerationService {
  constructor(
    private readonly attempts: AttemptRepo,
    private readonly audit: AuditService,
  ) {}

  async listQueue(actor: ActorForModeration): Promise<ModerationQueueRow[]> {
    this.assertAdmin(actor);
    return this.attempts.listModerationQueue();
  }

  async listPilotQueue(actor: ActorForModeration): Promise<ModerationQueueRow[]> {
    this.assertAdmin(actor);
    return this.attempts.listPilotShadowQueue();
  }

  async findDetail(actor: ActorForModeration, awardedMarkId: string): Promise<ModerationDetailRow> {
    this.assertAdmin(actor);
    const row = await this.attempts.findAwardedMarkForModeration(awardedMarkId);
    if (!row) throw new ModerationError('not_found');
    return row;
  }

  async accept(actor: ActorForModeration, awardedMarkId: string): Promise<void> {
    this.assertAdmin(actor);
    const row = await this.attempts.findAwardedMarkForModeration(awardedMarkId);
    if (!row) throw new ModerationError('not_found');
    if (row.moderation_status !== 'pending') throw new ModerationError('already_resolved');
    const result = await this.attempts.acceptAiMark({
      awardedMarkId,
      reviewerId: actor.id,
    });
    if (!result.updated) throw new ModerationError('already_resolved');
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'moderation.accepted',
      {
        awarded_mark_id: awardedMarkId,
        attempt_id: row.attempt_id,
        attempt_part_id: row.attempt_part_id,
        marks_awarded: row.marks_awarded,
        marks_total: row.marks_total,
      },
      row.pupil_id,
    );
  }

  async override(actor: ActorForModeration, input: OverrideAiMarkInput): Promise<void> {
    this.assertAdmin(actor);
    const row = await this.attempts.findAwardedMarkForModeration(input.awardedMarkId);
    if (!row) throw new ModerationError('not_found');
    if (row.moderation_status !== 'pending') throw new ModerationError('already_resolved');
    if (
      !Number.isInteger(input.marksAwarded) ||
      input.marksAwarded < 0 ||
      input.marksAwarded > row.part_marks
    ) {
      throw new ModerationError('invalid_marks');
    }
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length === 0 || trimmedReason.length > 500) {
      throw new ModerationError('invalid_reason');
    }
    const result = await this.attempts.overrideAiMarkInTxn({
      awardedMarkId: input.awardedMarkId,
      attemptPartId: row.attempt_part_id,
      reviewerId: actor.id,
      marksAwarded: input.marksAwarded,
      marksTotal: row.part_marks,
      reason: trimmedReason,
    });
    if (!result.updatedOriginal) throw new ModerationError('already_resolved');
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'moderation.overridden',
      {
        awarded_mark_id: input.awardedMarkId,
        new_awarded_mark_id: result.newAwardedMarkId,
        attempt_id: row.attempt_id,
        attempt_part_id: row.attempt_part_id,
        original_marks_awarded: row.marks_awarded,
        new_marks_awarded: input.marksAwarded,
        marks_total: row.part_marks,
        reason: trimmedReason,
      },
      row.pupil_id,
    );
  }

  // Chunk 3i. Record the teacher's shadow mark against a pilot row.
  // Always writes a teacher_override row, even when marks match the
  // AI, so the pilot-report CSV can count full-agreement decisions
  // too. Flips pilot_shadow_status to 'reviewed' without touching
  // moderation_status (the pupil-facing row stays alive).
  async recordPilotShadowReview(
    actor: ActorForModeration,
    input: PilotShadowReviewInput,
  ): Promise<void> {
    this.assertAdmin(actor);
    const row = await this.attempts.findAwardedMarkForModeration(input.awardedMarkId);
    if (!row) throw new ModerationError('not_found');
    if (row.marker !== 'llm') throw new ModerationError('not_found');
    // This is a pilot-shadow action; the existing moderation_status
    // is orthogonal. What matters is that the row is still pending
    // shadow review — once reviewed, repeat submissions 409.
    if (
      !Number.isInteger(input.teacherMarksAwarded) ||
      input.teacherMarksAwarded < 0 ||
      input.teacherMarksAwarded > row.part_marks
    ) {
      throw new ModerationError('invalid_marks');
    }
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length === 0 || trimmedReason.length > 500) {
      throw new ModerationError('invalid_reason');
    }
    const result = await this.attempts.recordPilotShadowReview({
      awardedMarkId: input.awardedMarkId,
      attemptPartId: row.attempt_part_id,
      reviewerId: actor.id,
      teacherMarksAwarded: input.teacherMarksAwarded,
      marksTotal: row.part_marks,
      reason: trimmedReason,
    });
    if (!result.updatedOriginal) throw new ModerationError('already_resolved');
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'moderation.pilot_reviewed',
      {
        awarded_mark_id: input.awardedMarkId,
        new_awarded_mark_id: result.newAwardedMarkId,
        attempt_id: row.attempt_id,
        attempt_part_id: row.attempt_part_id,
        ai_marks_awarded: row.marks_awarded,
        teacher_marks_awarded: input.teacherMarksAwarded,
        marks_total: row.part_marks,
        // Flag agreement vs disagreement explicitly so the CSV rollup
        // doesn't have to recompute it from the pair.
        agreement_within_1: Math.abs(row.marks_awarded - input.teacherMarksAwarded) <= 1,
      },
      row.pupil_id,
    );
  }

  private assertAdmin(actor: ActorForModeration): void {
    if (actor.role !== 'admin') throw new ModerationError('not_admin');
  }
}
