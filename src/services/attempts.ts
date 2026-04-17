import type {
  AttemptBundle,
  AttemptPartMarkPointRow,
  AttemptPartRow,
  AttemptRepo,
  PupilAttemptSummary,
  SubmittedAttemptSummary,
} from '../repos/attempts.js';
import type { ClassRepo } from '../repos/classes.js';
import type { RevealMode, UserRepo, UserRow } from '../repos/users.js';
import {
  markAttemptPart,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from './marking/deterministic.js';
import type { AuditService } from './audit.js';

export type ActorForAttempt = Pick<UserRow, 'id' | 'role'>;

export class AttemptAccessError extends Error {
  constructor(
    public readonly reason:
      | 'not_pupil'
      | 'not_teacher'
      | 'not_owner'
      | 'not_found'
      | 'no_questions'
      | 'not_enrolled'
      | 'already_submitted'
      | 'not_yet_submitted'
      | 'question_already_submitted'
      | 'not_submitted_yet'
      | 'invalid_self_marks',
  ) {
    super(`attempt access denied: ${reason}`);
    this.name = 'AttemptAccessError';
  }
}

export interface StartTopicSetResult {
  attemptId: string;
  questionCount: number;
  resumed?: boolean;
}

export class AttemptService {
  constructor(
    private readonly repo: AttemptRepo,
    private readonly classRepo: ClassRepo,
    private readonly audit: AuditService,
    private readonly userRepo?: UserRepo,
  ) {}

  async listAttemptsForPupil(actor: ActorForAttempt): Promise<PupilAttemptSummary[]> {
    if (actor.role !== 'pupil') throw new AttemptAccessError('not_pupil');
    return this.repo.listAttemptsForUser(actor.id);
  }

  async setRevealModeForUser(actor: ActorForAttempt, mode: RevealMode): Promise<void> {
    if (!this.userRepo) throw new Error('UserRepo not configured');
    await this.userRepo.setRevealMode(actor.id, mode);
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'user.reveal_mode.set',
      { mode },
      actor.id,
    );
  }

  async listTopicsForPupil(actor: ActorForAttempt): Promise<
    {
      topic_code: string;
      topic_title: string;
      component_code: string;
      in_progress_attempt_id: string | null;
    }[]
  > {
    if (actor.role !== 'pupil') throw new AttemptAccessError('not_pupil');
    const topics = await this.classRepo.listAssignedTopicsForPupil(actor.id);
    const inProgress = await this.repo.listInProgressAttemptsForPupilTopics(
      actor.id,
      topics.map((t) => t.topic_code),
    );
    return topics.map((t) => ({
      topic_code: t.topic_code,
      topic_title: t.topic_title,
      component_code: t.component_code,
      in_progress_attempt_id: inProgress.get(t.topic_code) ?? null,
    }));
  }

  async startTopicSet(
    actor: ActorForAttempt,
    topicCode: string,
    revealMode: RevealMode = 'per_question',
  ): Promise<StartTopicSetResult> {
    if (actor.role !== 'pupil') throw new AttemptAccessError('not_pupil');
    const cls = await this.classRepo.findClassForPupilAndTopic(actor.id, topicCode);
    if (!cls) throw new AttemptAccessError('not_enrolled');

    // Enforce one in-progress attempt per (pupil, topic). If one exists, hand
    // the caller back that id so it can redirect the pupil to resume it.
    const existing = await this.repo.findInProgressAttemptForPupilTopic(actor.id, topicCode);
    if (existing) {
      return { attemptId: existing, questionCount: 0, resumed: true };
    }

    const result = await this.repo.createTopicSetAttempt({
      userId: actor.id,
      classId: cls.class_id,
      topicCode,
      limit: cls.topic_set_size,
      revealMode,
    });
    if ('error' in result) throw new AttemptAccessError('no_questions');

    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'attempt.started',
      {
        attempt_id: result.attemptId,
        topic_code: topicCode,
        class_id: cls.class_id,
        question_count: result.questionCount,
      },
      actor.id,
    );
    return { attemptId: result.attemptId, questionCount: result.questionCount };
  }

  async getAttemptForActor(actor: ActorForAttempt, attemptId: string): Promise<AttemptBundle> {
    const bundle = await this.repo.loadAttemptBundle(attemptId);
    if (!bundle) throw new AttemptAccessError('not_found');
    if (actor.role === 'admin') return bundle;
    if (bundle.attempt.user_id === actor.id) return bundle;
    if (actor.role === 'teacher') {
      const cls = await this.classRepo.findById(bundle.attempt.class_id);
      if (cls?.teacher_id === actor.id) return bundle;
    }
    throw new AttemptAccessError('not_owner');
  }

  async listSubmittedAttemptsForClass(
    actor: ActorForAttempt,
    classId: string,
  ): Promise<SubmittedAttemptSummary[]> {
    if (actor.role !== 'teacher' && actor.role !== 'admin') {
      throw new AttemptAccessError('not_teacher');
    }
    if (actor.role === 'teacher') {
      const cls = await this.classRepo.findById(classId);
      if (cls?.teacher_id !== actor.id) throw new AttemptAccessError('not_owner');
    }
    return this.repo.listSubmittedAttemptsForClass(classId);
  }

  async saveAnswer(
    actor: ActorForAttempt,
    attemptId: string,
    answers: { attemptPartId: string; rawAnswer: string }[],
  ): Promise<{ saved: number }> {
    const bundle = await this.getAttemptForActor(actor, attemptId);
    if (bundle.attempt.submitted_at !== null) throw new AttemptAccessError('already_submitted');

    const editableIds = new Set<string>();
    for (const list of bundle.partsByQuestion.values()) {
      for (const p of list) {
        if (p.submitted_at === null) editableIds.add(p.id);
      }
    }

    let saved = 0;
    for (const a of answers) {
      if (!editableIds.has(a.attemptPartId)) continue;
      const trimmed = a.rawAnswer.slice(0, 5000);
      const rc = await this.repo.saveAnswer(a.attemptPartId, trimmed);
      saved += rc;
    }

    if (saved > 0) {
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'attempt.part.saved',
        { attempt_id: attemptId, parts_saved: saved },
        actor.id,
      );
    }
    return { saved };
  }

  async submitAttempt(
    actor: ActorForAttempt,
    attemptId: string,
  ): Promise<{ markedParts: number; pendingParts: number }> {
    const bundle = await this.getAttemptForActor(actor, attemptId);
    if (bundle.attempt.submitted_at !== null) throw new AttemptAccessError('already_submitted');

    await this.repo.markSubmitted(attemptId);

    let markedParts = 0;
    let pendingParts = 0;
    for (const parts of bundle.partsByQuestion.values()) {
      for (const part of parts) {
        if (bundle.awardedByAttemptPart.has(part.id)) continue;
        const mps = bundle.markPointsByPart.get(part.question_part_id) ?? [];
        const outcome = runDeterministicMarker(part, mps);
        if (outcome.kind === 'awarded') {
          await this.repo.writeDeterministicMark({
            attemptPartId: part.id,
            marksAwarded: outcome.marks_awarded,
            marksTotal: outcome.marks_possible,
            markPointsHit: outcome.hitMarkPointIds,
            markPointsMissed: outcome.missedMarkPointIds,
          });
          markedParts++;
        } else {
          pendingParts++;
        }
      }
    }

    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'attempt.submitted',
      { attempt_id: attemptId },
      actor.id,
    );
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'marking.completed',
      {
        attempt_id: attemptId,
        marker: 'deterministic',
        marked_parts: markedParts,
        pending_parts: pendingParts,
      },
      actor.id,
    );
    return { markedParts, pendingParts };
  }

  async submitQuestion(
    actor: ActorForAttempt,
    attemptId: string,
    attemptQuestionId: string,
  ): Promise<{ markedParts: number; pendingParts: number; attemptFullySubmitted: boolean }> {
    const bundle = await this.getAttemptForActor(actor, attemptId);
    if (bundle.attempt.submitted_at !== null) throw new AttemptAccessError('already_submitted');

    const question = bundle.questions.find((q) => q.id === attemptQuestionId);
    if (!question) throw new AttemptAccessError('not_found');
    if (question.submitted_at !== null) {
      throw new AttemptAccessError('question_already_submitted');
    }

    await this.repo.markQuestionSubmitted(attemptQuestionId);

    let markedParts = 0;
    let pendingParts = 0;
    const parts = bundle.partsByQuestion.get(attemptQuestionId) ?? [];
    for (const part of parts) {
      if (bundle.awardedByAttemptPart.has(part.id)) continue;
      const mps = bundle.markPointsByPart.get(part.question_part_id) ?? [];
      const outcome = runDeterministicMarker(part, mps);
      if (outcome.kind === 'awarded') {
        await this.repo.writeDeterministicMark({
          attemptPartId: part.id,
          marksAwarded: outcome.marks_awarded,
          marksTotal: outcome.marks_possible,
          markPointsHit: outcome.hitMarkPointIds,
          markPointsMissed: outcome.missedMarkPointIds,
        });
        markedParts++;
      } else {
        pendingParts++;
      }
    }

    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'attempt.question.submitted',
      {
        attempt_id: attemptId,
        attempt_question_id: attemptQuestionId,
        marked_parts: markedParts,
        pending_parts: pendingParts,
      },
      actor.id,
    );

    let attemptFullySubmitted = false;
    const remaining = await this.repo.countUnsubmittedQuestions(attemptId);
    if (remaining === 0) {
      await this.repo.markSubmitted(attemptId);
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'attempt.submitted',
        { attempt_id: attemptId, trigger: 'final_question' },
        actor.id,
      );
      attemptFullySubmitted = true;
    }

    return { markedParts, pendingParts, attemptFullySubmitted };
  }

  async recordPupilSelfMark(
    actor: ActorForAttempt,
    attemptId: string,
    attemptPartId: string,
    marks: number | null,
  ): Promise<void> {
    const bundle = await this.getAttemptForActor(actor, attemptId);
    let target: AttemptPartRow | undefined;
    for (const list of bundle.partsByQuestion.values()) {
      const p = list.find((x) => x.id === attemptPartId);
      if (p) {
        target = p;
        break;
      }
    }
    if (!target) throw new AttemptAccessError('not_found');
    if (target.submitted_at === null && bundle.attempt.submitted_at === null) {
      throw new AttemptAccessError('not_submitted_yet');
    }
    if (marks !== null && (marks < 0 || marks > target.marks || !Number.isInteger(marks))) {
      throw new AttemptAccessError('invalid_self_marks');
    }
    await this.repo.setPupilSelfMark(attemptPartId, marks);
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'attempt.part.self_mark',
      { attempt_id: attemptId, attempt_part_id: attemptPartId, marks },
      actor.id,
    );
  }
}

interface DeterministicAwarded {
  kind: 'awarded';
  marks_awarded: number;
  marks_possible: number;
  hitMarkPointIds: string[];
  missedMarkPointIds: string[];
}
type DeterministicOutcome = DeterministicAwarded | { kind: 'pending' };

function runDeterministicMarker(
  part: AttemptPartRow,
  markPoints: readonly AttemptPartMarkPointRow[],
): DeterministicOutcome {
  const input: MarkingInputPart = {
    marks: part.marks,
    expected_response_type: part.expected_response_type,
  };
  const mps: MarkingInputMarkPoint[] = markPoints.map((mp) => ({
    text: mp.text,
    accepted_alternatives: mp.accepted_alternatives,
    marks: mp.marks,
    is_required: mp.is_required,
  }));
  const result = markAttemptPart(input, part.raw_answer, mps);
  if (result.kind === 'teacher_pending') return { kind: 'pending' };

  const hit: string[] = [];
  const missed: string[] = [];
  for (let i = 0; i < result.mark_point_outcomes.length; i++) {
    const id = markPoints[i]!.id;
    if (result.mark_point_outcomes[i]!.hit) hit.push(id);
    else missed.push(id);
  }
  return {
    kind: 'awarded',
    marks_awarded: result.marks_awarded,
    marks_possible: result.marks_possible,
    hitMarkPointIds: hit,
    missedMarkPointIds: missed,
  };
}
