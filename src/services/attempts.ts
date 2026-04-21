import type {
  AttemptBundle,
  AttemptPartMarkPointRow,
  AttemptPartRow,
  AttemptQuestionRow,
  AttemptRepo,
  PupilAttemptSummary,
  SubmittedAttemptSummary,
  TeacherQueueRow,
  TopicPreviewBundle,
} from '../repos/attempts.js';
import type { ClassRepo } from '../repos/classes.js';
import type {
  FontPreference,
  RevealMode,
  ThemePreference,
  UserRepo,
  UserRow,
} from '../repos/users.js';
import {
  markAttemptPart,
  type MarkingInputMarkPoint,
  type MarkingInputPart,
} from './marking/deterministic.js';
import type { DispatchOutcome, MarkingDispatcher } from './marking/dispatch.js';
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

const AUTOSAVE_AUDIT_DEBOUNCE_MS = 60_000;

export class AttemptService {
  private readonly autosaveAuditLastAt = new Map<string, number>();

  constructor(
    private readonly repo: AttemptRepo,
    private readonly classRepo: ClassRepo,
    private readonly audit: AuditService,
    private readonly userRepo?: UserRepo,
    private readonly dispatcher?: MarkingDispatcher,
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

  async setFontPreferenceForUser(actor: ActorForAttempt, font: FontPreference): Promise<void> {
    if (!this.userRepo) throw new Error('UserRepo not configured');
    await this.userRepo.setFontPreference(actor.id, font);
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'user.font_preference.set',
      { font },
      actor.id,
    );
  }

  async setThemePreferenceForUser(actor: ActorForAttempt, theme: ThemePreference): Promise<void> {
    if (!this.userRepo) throw new Error('UserRepo not configured');
    await this.userRepo.setThemePreference(actor.id, theme);
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'user.theme_preference.set',
      { theme },
      actor.id,
    );
  }

  async dismissWidgetTipForUser(actor: ActorForAttempt, widgetKey: string): Promise<void> {
    if (!this.userRepo) throw new Error('UserRepo not configured');
    await this.userRepo.dismissWidgetTip(actor.id, widgetKey, new Date());
    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'user.widget_tip.dismissed',
      { widget_key: widgetKey },
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
      timerMinutes: cls.timer_minutes,
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
        timer_minutes: cls.timer_minutes,
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

  async getTopicPreviewForActor(
    actor: ActorForAttempt,
    topicCode: string,
    limit = 8,
  ): Promise<TopicPreviewBundle> {
    if (actor.role !== 'teacher' && actor.role !== 'admin') {
      throw new AttemptAccessError('not_teacher');
    }
    const result = await this.repo.loadTopicPreview(topicCode, limit);
    if ('error' in result) throw new AttemptAccessError('no_questions');
    return result;
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

  async listMarkingQueueForTeacher(actor: ActorForAttempt): Promise<TeacherQueueRow[]> {
    if (actor.role !== 'teacher' && actor.role !== 'admin') {
      throw new AttemptAccessError('not_teacher');
    }
    return this.repo.listAwaitingMarkingForTeacher(actor.id);
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

  async savePartOne(
    actor: ActorForAttempt,
    attemptPartId: string,
    rawAnswer: string,
  ): Promise<{ savedAt: Date }> {
    if (actor.role !== 'pupil') throw new AttemptAccessError('not_pupil');
    const ctx = await this.repo.findAttemptPartContext(attemptPartId);
    if (!ctx) throw new AttemptAccessError('not_found');
    if (ctx.pupil_id !== actor.id) throw new AttemptAccessError('not_owner');
    if (ctx.attempt_submitted_at !== null || ctx.submitted_at !== null) {
      throw new AttemptAccessError('already_submitted');
    }

    const trimmed = rawAnswer.slice(0, 5000);
    await this.repo.saveAnswer(attemptPartId, trimmed);
    const savedAt = new Date();

    const now = savedAt.getTime();
    const last = this.autosaveAuditLastAt.get(attemptPartId) ?? 0;
    if (now - last >= AUTOSAVE_AUDIT_DEBOUNCE_MS) {
      this.autosaveAuditLastAt.set(attemptPartId, now);
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'attempt.part.saved',
        {
          attempt_id: ctx.attempt_id,
          attempt_part_id: attemptPartId,
          source: 'autosave',
        },
        actor.id,
      );
    }

    return { savedAt };
  }

  async submitAttempt(
    actor: ActorForAttempt,
    attemptId: string,
    elapsedSecondsFromClient: number | null = null,
  ): Promise<{ markedParts: number; pendingParts: number; elapsedSeconds: number | null }> {
    const bundle = await this.getAttemptForActor(actor, attemptId);
    if (bundle.attempt.submitted_at !== null) throw new AttemptAccessError('already_submitted');

    const elapsed = clampElapsedSeconds(elapsedSecondsFromClient, bundle.attempt.timer_minutes);
    await this.repo.markSubmitted(attemptId, elapsed);

    let markedParts = 0;
    let pendingParts = 0;
    for (const question of bundle.questions) {
      const parts = bundle.partsByQuestion.get(question.id) ?? [];
      for (const part of parts) {
        if (bundle.awardedByAttemptPart.has(part.id)) continue;
        const mps = bundle.markPointsByPart.get(part.question_part_id) ?? [];
        const outcome = await this.dispatchPart(actor, question, part, mps);
        if (outcome.kind === 'deterministic_awarded' || outcome.kind === 'llm_awarded') {
          markedParts++;
        } else {
          pendingParts++;
        }
      }
    }

    await this.audit.record(
      { userId: actor.id, role: actor.role },
      'attempt.submitted',
      { attempt_id: attemptId, elapsed_seconds: elapsed },
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
    return { markedParts, pendingParts, elapsedSeconds: elapsed };
  }

  async submitQuestion(
    actor: ActorForAttempt,
    attemptId: string,
    attemptQuestionId: string,
    elapsedSecondsFromClient: number | null = null,
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
      const outcome = await this.dispatchPart(actor, question, part, mps);
      if (outcome.kind === 'deterministic_awarded' || outcome.kind === 'llm_awarded') {
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
      const elapsed = clampElapsedSeconds(elapsedSecondsFromClient, bundle.attempt.timer_minutes);
      await this.repo.markSubmitted(attemptId, elapsed);
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        'attempt.submitted',
        { attempt_id: attemptId, trigger: 'final_question', elapsed_seconds: elapsed },
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

  // Runs the marking dispatcher for a single attempt_part and persists
  // the awarded_marks row for an `awarded` outcome. Audit events emitted
  // by the LLM path are forwarded to the audit service one-per-outcome,
  // matching the llm_calls row-per-outcome invariant. Missing dispatcher
  // (e.g. a test that does not wire LLM) falls back to deterministic
  // only — the same behaviour as Phase 2.5.
  private async dispatchPart(
    actor: ActorForAttempt,
    question: AttemptQuestionRow,
    part: AttemptPartRow,
    markPoints: readonly AttemptPartMarkPointRow[],
  ): Promise<DispatchOutcome> {
    if (!this.dispatcher) {
      const fallback = buildDeterministicFallback(part, markPoints);
      if (fallback.kind === 'deterministic_awarded') {
        await this.repo.writeDeterministicMark({
          attemptPartId: part.id,
          marksAwarded: fallback.marksAwarded,
          marksTotal: fallback.marksTotal,
          markPointsHit: fallback.hitMarkPointIds,
          markPointsMissed: fallback.missedMarkPointIds,
        });
      }
      return fallback;
    }

    const outcome = await this.dispatcher.dispatch({
      question: { stem: question.stem, model_answer: question.model_answer },
      part,
      markPoints,
    });

    if (outcome.kind === 'deterministic_awarded') {
      await this.repo.writeDeterministicMark({
        attemptPartId: part.id,
        marksAwarded: outcome.marksAwarded,
        marksTotal: outcome.marksTotal,
        markPointsHit: outcome.hitMarkPointIds,
        markPointsMissed: outcome.missedMarkPointIds,
      });
    } else if (outcome.kind === 'llm_awarded') {
      await this.repo.writeLlmMark({
        attemptPartId: part.id,
        marksAwarded: outcome.marksAwarded,
        marksTotal: outcome.marksTotal,
        markPointsHit: outcome.hitMarkPointIds,
        markPointsMissed: outcome.missedMarkPointIds,
        evidenceQuotes: outcome.evidenceQuotes,
        confidence: outcome.confidence,
        promptVersion: `${outcome.promptVersion.name}@${outcome.promptVersion.version}`,
        modelId: outcome.promptVersion.model_id,
        moderationRequired: outcome.moderationRequired,
        moderationStatus: outcome.moderationStatus,
        moderationNotes: outcome.moderationNotes,
      });
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        outcome.auditEvent,
        outcome.auditDetails,
        actor.id,
      );
    } else if (outcome.auditEvent) {
      await this.audit.record(
        { userId: actor.id, role: actor.role },
        outcome.auditEvent,
        outcome.auditDetails ?? {},
        actor.id,
      );
    }

    return outcome;
  }
}

function clampElapsedSeconds(raw: number | null, timerMinutes: number | null): number | null {
  if (timerMinutes === null) return null;
  if (raw === null || !Number.isFinite(raw)) return null;
  const ceiling = timerMinutes * 60 + 30;
  const floored = Math.max(0, Math.floor(raw));
  return Math.min(floored, ceiling);
}

// Minimal deterministic-only dispatch for callers that don't wire a
// MarkingDispatcher (most tests). Mirrors the awarded/pending union in
// dispatch.ts but skips the LLM path entirely.
function buildDeterministicFallback(
  part: AttemptPartRow,
  markPoints: readonly AttemptPartMarkPointRow[],
): DispatchOutcome {
  const markingPart: MarkingInputPart = {
    marks: part.marks,
    expected_response_type: part.expected_response_type,
    part_config: part.part_config,
  };
  const mps: MarkingInputMarkPoint[] = markPoints.map((mp) => ({
    text: mp.text,
    accepted_alternatives: mp.accepted_alternatives,
    marks: mp.marks,
    is_required: mp.is_required,
  }));
  const result = markAttemptPart(markingPart, part.raw_answer, mps);
  if (result.kind === 'teacher_pending') {
    return { kind: 'pending', reason: result.reason };
  }
  const hit: string[] = [];
  const missed: string[] = [];
  for (let i = 0; i < result.mark_point_outcomes.length; i++) {
    const id = markPoints[i]!.id;
    if (result.mark_point_outcomes[i]!.hit) hit.push(id);
    else missed.push(id);
  }
  return {
    kind: 'deterministic_awarded',
    marksAwarded: result.marks_awarded,
    marksTotal: result.marks_possible,
    hitMarkPointIds: hit,
    missedMarkPointIds: missed,
  };
}
