import type { AttemptRepo } from '../../repos/attempts.js';
import type { UserRow } from '../../repos/users.js';
import type { AuditService } from '../audit.js';

export type ActorForTeacherMarking = Pick<UserRow, 'id' | 'role'>;

export class TeacherMarkingError extends Error {
  constructor(
    public readonly reason:
      | 'not_teacher'
      | 'not_owner'
      | 'not_found'
      | 'not_yet_submitted'
      | 'self_marking'
      | 'invalid_marks'
      | 'invalid_reason',
  ) {
    super(`teacher marking denied: ${reason}`);
    this.name = 'TeacherMarkingError';
  }
}

// Two outcomes from a teacher mark submission:
//   - 'confirmed' — the teacher's mark equals the existing awarded
//     mark (deterministic / AI / a previous override). No new
//     awarded_marks row, no `teacher_override` badge on the page; the
//     part still surfaces as it was, just with an audit row showing
//     the teacher reviewed it. Closes bug_notes.md #3 (29 Apr 2026).
//   - 'overridden' — marks differ. New awarded_marks row with
//     marker='teacher_override' and a teacher_overrides reason row;
//     the page renders the amber override badge.
//
// Reason is allowed to be empty when the teacher is confirming; that
// closes bug_notes.md #4 (29 Apr 2026). For an override the reason
// is still required so the audit trail explains the change.
export interface SetTeacherMarkResult {
  kind: 'confirmed' | 'overridden';
  awardedMarkId: string | null;
  marksAwarded: number;
  marksTotal: number;
}

export class TeacherMarkingService {
  constructor(
    private readonly repo: AttemptRepo,
    private readonly audit: AuditService,
  ) {}

  async setTeacherMark(
    actor: ActorForTeacherMarking,
    attemptPartId: string,
    marksAwarded: number,
    reason: string,
  ): Promise<SetTeacherMarkResult> {
    if (actor.role !== 'teacher' && actor.role !== 'admin') {
      throw new TeacherMarkingError('not_teacher');
    }

    const ctx = await this.repo.findAttemptPartContext(attemptPartId);
    if (!ctx) throw new TeacherMarkingError('not_found');
    if (ctx.attempt_submitted_at === null) throw new TeacherMarkingError('not_yet_submitted');
    if (actor.role === 'teacher' && ctx.teacher_id !== actor.id) {
      throw new TeacherMarkingError('not_owner');
    }
    if (ctx.pupil_id === actor.id) {
      throw new TeacherMarkingError('self_marking');
    }

    if (!Number.isInteger(marksAwarded) || marksAwarded < 0 || marksAwarded > ctx.part_marks) {
      throw new TeacherMarkingError('invalid_marks');
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length > 500) {
      throw new TeacherMarkingError('invalid_reason');
    }

    // Confirmation branch: teacher saved the same mark that's
    // already on the row, so there's nothing to override.
    const existing = await this.repo.findAwardedMarkForPart(attemptPartId);
    const isConfirmation = existing !== null && existing.marks_awarded === marksAwarded;
    if (isConfirmation) {
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'marking.confirmed',
        {
          attempt_id: ctx.attempt_id,
          attempt_part_id: attemptPartId,
          awarded_mark_id: existing.id,
          marks_awarded: marksAwarded,
          marks_total: ctx.part_marks,
          original_marker: existing.marker,
          reason: trimmedReason.length > 0 ? trimmedReason : null,
        },
        ctx.pupil_id,
      );
      return {
        kind: 'confirmed',
        awardedMarkId: existing.id,
        marksAwarded,
        marksTotal: ctx.part_marks,
      };
    }

    // Override branch — reason mandatory because the teacher is
    // changing the mark and the audit trail must explain why.
    if (trimmedReason.length === 0) {
      throw new TeacherMarkingError('invalid_reason');
    }

    const { awardedMarkId } = await this.repo.insertTeacherOverride({
      attemptPartId,
      teacherId: actor.id,
      marksAwarded,
      marksTotal: ctx.part_marks,
      reason: trimmedReason,
    });

    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'marking.override',
      {
        attempt_id: ctx.attempt_id,
        attempt_part_id: attemptPartId,
        awarded_mark_id: awardedMarkId,
        marks_awarded: marksAwarded,
        marks_total: ctx.part_marks,
        previous_marks_awarded: existing?.marks_awarded ?? null,
        previous_marker: existing?.marker ?? null,
        reason: trimmedReason,
      },
      ctx.pupil_id,
    );

    return {
      kind: 'overridden',
      awardedMarkId,
      marksAwarded,
      marksTotal: ctx.part_marks,
    };
  }
}
