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

export interface SetTeacherMarkResult {
  awardedMarkId: string;
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
    if (trimmedReason.length === 0 || trimmedReason.length > 500) {
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
        reason: trimmedReason,
      },
      ctx.pupil_id,
    );

    return {
      awardedMarkId,
      marksAwarded,
      marksTotal: ctx.part_marks,
    };
  }
}
