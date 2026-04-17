import type {
  AssignedTopicRow,
  ClassRepo,
  ClassRow,
  ClassWithTeacherRow,
  EnrolledPupilRow,
} from '../repos/classes.js';
import type { UserRow } from '../repos/users.js';
import type { AuditService } from './audit.js';

export type ActorForClass = Pick<UserRow, 'id' | 'role'>;

export class ClassAccessError extends Error {
  constructor(
    public readonly reason: 'not_teacher' | 'not_owner' | 'pupil_not_found' | 'invalid_timer',
  ) {
    super(`class access denied: ${reason}`);
    this.name = 'ClassAccessError';
  }
}

export function canManageClasses(actor: Pick<UserRow, 'role'>): boolean {
  return actor.role === 'teacher' || actor.role === 'admin';
}

export function canManageClass(actor: ActorForClass, cls: Pick<ClassRow, 'teacher_id'>): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'teacher') return false;
  return cls.teacher_id === actor.id;
}

export interface CreateClassInput {
  name: string;
  academicYear: string;
}

export class ClassService {
  constructor(
    private readonly repo: ClassRepo,
    private readonly audit: AuditService,
  ) {}

  async createClass(actor: ActorForClass, input: CreateClassInput): Promise<ClassRow> {
    if (!canManageClasses(actor)) throw new ClassAccessError('not_teacher');
    const row = await this.repo.createClass({
      name: input.name,
      academicYear: input.academicYear,
      teacherId: actor.id,
    });
    await this.audit.record({ userId: actor.id, role: actor.role }, 'class.created', {
      class_id: row.id,
      name: row.name,
      academic_year: row.academic_year,
    });
    return row;
  }

  async listClassesFor(actor: ActorForClass): Promise<ClassRow[] | ClassWithTeacherRow[]> {
    if (!canManageClasses(actor)) throw new ClassAccessError('not_teacher');
    if (actor.role === 'admin') return this.repo.listAllWithTeacher();
    return this.repo.listForTeacher(actor.id);
  }

  async getClassFor(actor: ActorForClass, classId: string): Promise<ClassRow | null> {
    if (!canManageClasses(actor)) throw new ClassAccessError('not_teacher');
    const cls = await this.repo.findById(classId);
    if (!cls) return null;
    if (!canManageClass(actor, cls)) throw new ClassAccessError('not_owner');
    return cls;
  }

  async listPupils(actor: ActorForClass, classId: string): Promise<EnrolledPupilRow[]> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) return [];
    return this.repo.listPupilsInClass(classId);
  }

  async enrolPupilByUsername(
    actor: ActorForClass,
    classId: string,
    pupilUsername: string,
  ): Promise<{ status: 'added' | 'already'; pupilId: string; pupilDisplayName: string }> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) throw new ClassAccessError('not_owner');
    const pupil = await this.repo.findPupilByUsername(pupilUsername);
    if (!pupil) throw new ClassAccessError('pupil_not_found');
    const status = await this.repo.addEnrolment(classId, pupil.id);
    if (status === 'added') {
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'enrolment.added',
        { class_id: classId, pupil_id: pupil.id, pupil_username: pupilUsername },
        pupil.id,
      );
    }
    return { status, pupilId: pupil.id, pupilDisplayName: pupil.display_name };
  }

  async removePupil(
    actor: ActorForClass,
    classId: string,
    pupilId: string,
  ): Promise<'removed' | 'not_enrolled'> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) throw new ClassAccessError('not_owner');
    const status = await this.repo.removeEnrolment(classId, pupilId);
    if (status === 'removed') {
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'enrolment.removed',
        { class_id: classId, pupil_id: pupilId },
        pupilId,
      );
    }
    return status;
  }

  async listAssignedTopics(actor: ActorForClass, classId: string): Promise<AssignedTopicRow[]> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) return [];
    return this.repo.listAssignedTopics(classId);
  }

  async assignTopic(
    actor: ActorForClass,
    classId: string,
    topicCode: string,
  ): Promise<'added' | 'already'> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) throw new ClassAccessError('not_owner');
    const status = await this.repo.assignTopic(classId, topicCode, actor.id);
    if (status === 'added') {
      await this.audit.record({ userId: actor.id, role: actor.role }, 'class.topic.assigned', {
        class_id: classId,
        topic_code: topicCode,
      });
    }
    return status;
  }

  async setClassTimer(
    actor: ActorForClass,
    classId: string,
    minutes: number | null,
  ): Promise<ClassRow> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) throw new ClassAccessError('not_owner');
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 180)) {
      throw new ClassAccessError('invalid_timer');
    }
    const updated = await this.repo.updateClassTimer(classId, minutes);
    if (!updated) throw new ClassAccessError('not_owner');
    await this.audit.record({ userId: actor.id, role: actor.role }, 'class.timer_set', {
      class_id: classId,
      timer_minutes: minutes,
    });
    return updated;
  }

  async unassignTopic(
    actor: ActorForClass,
    classId: string,
    topicCode: string,
  ): Promise<'removed' | 'not_assigned'> {
    const cls = await this.getClassFor(actor, classId);
    if (!cls) throw new ClassAccessError('not_owner');
    const status = await this.repo.unassignTopic(classId, topicCode);
    if (status === 'removed') {
      await this.audit.record({ userId: actor.id, role: actor.role }, 'class.topic.unassigned', {
        class_id: classId,
        topic_code: topicCode,
      });
    }
    return status;
  }
}
