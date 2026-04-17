import type { Pool, PoolClient } from 'pg';

export interface SavedAttempt {
  attempt_id: string;
  attempt_question_id: string;
  part_ids: string[];
}

export interface AttemptRow {
  id: string;
  user_id: string;
  class_id: string;
  mode: string;
  started_at: Date;
  submitted_at: Date | null;
  target_topic_code: string | null;
  reveal_mode: 'per_question' | 'whole_attempt';
  timer_minutes: number | null;
  elapsed_seconds: number | null;
}

export interface AttemptQuestionRow {
  id: string;
  attempt_id: string;
  question_id: string;
  display_order: number;
  stem: string;
  topic_code: string;
  subtopic_code: string;
  command_word_code: string;
  marks_total: number;
  submitted_at: Date | null;
}

export interface AttemptPartRow {
  id: string;
  attempt_question_id: string;
  question_part_id: string;
  part_label: string;
  prompt: string;
  marks: number;
  expected_response_type: string;
  display_order: number;
  raw_answer: string;
  last_saved_at: Date;
  submitted_at: Date | null;
  pupil_self_marks: number | null;
}

export interface AttemptPartMarkPointRow {
  id: string;
  question_part_id: string;
  text: string;
  accepted_alternatives: string[];
  marks: number;
  is_required: boolean;
  display_order: number;
}

export interface AwardedMarkRow {
  id: string;
  attempt_part_id: string;
  marks_awarded: number;
  marks_total: number;
  mark_points_hit: string[];
  mark_points_missed: string[];
  marker: 'deterministic' | 'llm' | 'teacher_override';
  created_at: Date;
}

export interface PaperHeader {
  componentCode: string | null;
  componentTitle: string | null;
  topicCode: string | null;
  topicTitle: string | null;
  totalMarks: number;
}

export interface AttemptBundle {
  attempt: AttemptRow;
  questions: AttemptQuestionRow[];
  partsByQuestion: Map<string, AttemptPartRow[]>;
  markPointsByPart: Map<string, AttemptPartMarkPointRow[]>;
  awardedByAttemptPart: Map<string, AwardedMarkRow>;
  paper: PaperHeader;
}

export class AttemptRepo {
  constructor(private readonly pool: Pool) {}

  async findDemoClassId(): Promise<string | null> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM classes
        WHERE name = 'Phase 0 Demo'
        ORDER BY id
        LIMIT 1`,
    );
    return res.rows[0]?.id ?? null;
  }

  async saveSubmission(input: {
    userId: string;
    classId: string;
    questionId: string;
    parts: { questionPartId: string; rawAnswer: string }[];
  }): Promise<SavedAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const attempt = await client.query<{ id: string }>(
        `INSERT INTO attempts (user_id, class_id, mode, target_topic_code)
           VALUES ($1::bigint, $2::bigint, 'topic_set', NULL)
         RETURNING id::text`,
        [input.userId, input.classId],
      );
      const attemptId = attempt.rows[0]!.id;

      const aq = await client.query<{ id: string }>(
        `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
           VALUES ($1::bigint, $2::bigint, 1)
         RETURNING id::text`,
        [attemptId, input.questionId],
      );
      const attemptQuestionId = aq.rows[0]!.id;

      const partIds: string[] = [];
      for (const part of input.parts) {
        const ap = await client.query<{ id: string }>(
          `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer, submitted_at)
             VALUES ($1::bigint, $2::bigint, $3, now())
           RETURNING id::text`,
          [attemptQuestionId, part.questionPartId, part.rawAnswer],
        );
        partIds.push(ap.rows[0]!.id);
      }

      await client.query(`UPDATE attempts SET submitted_at = now() WHERE id = $1::bigint`, [
        attemptId,
      ]);

      await client.query('COMMIT');
      return { attempt_id: attemptId, attempt_question_id: attemptQuestionId, part_ids: partIds };
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async createTopicSetAttempt(input: {
    userId: string;
    classId: string;
    topicCode: string;
    limit: number;
    revealMode: 'per_question' | 'whole_attempt';
    timerMinutes: number | null;
  }): Promise<{ attemptId: string; questionCount: number } | { error: 'no_questions' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const picked = await client.query<{ id: string }>(
        `SELECT id::text
           FROM questions
          WHERE topic_code = $1
            AND active = true
            AND approval_status = 'approved'
          ORDER BY random()
          LIMIT $2`,
        [input.topicCode, input.limit],
      );
      if (picked.rowCount === 0) {
        await safeRollback(client);
        return { error: 'no_questions' };
      }

      const attempt = await client.query<{ id: string }>(
        `INSERT INTO attempts (user_id, class_id, mode, target_topic_code, reveal_mode, timer_minutes)
           VALUES ($1::bigint, $2::bigint, 'topic_set', $3, $4, $5)
         RETURNING id::text`,
        [input.userId, input.classId, input.topicCode, input.revealMode, input.timerMinutes],
      );
      const attemptId = attempt.rows[0]!.id;

      for (let i = 0; i < picked.rows.length; i++) {
        const questionId = picked.rows[i]!.id;
        const aq = await client.query<{ id: string }>(
          `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
             VALUES ($1::bigint, $2::bigint, $3)
           RETURNING id::text`,
          [attemptId, questionId, i + 1],
        );
        const aqId = aq.rows[0]!.id;
        await client.query(
          `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
             SELECT $1::bigint, qp.id, ''
               FROM question_parts qp
              WHERE qp.question_id = $2::bigint
              ORDER BY qp.display_order`,
          [aqId, questionId],
        );
      }

      await client.query('COMMIT');
      return { attemptId, questionCount: picked.rows.length };
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async loadTopicPreview(
    topicCode: string,
    limit: number,
  ): Promise<TopicPreviewBundle | { error: 'no_questions' }> {
    const { rows: picked } = await this.pool.query<{
      id: string;
      stem: string;
      topic_code: string;
      subtopic_code: string;
      command_word_code: string;
      marks_total: number;
    }>(
      `SELECT id::text, stem, topic_code, subtopic_code, command_word_code, marks_total
         FROM questions
        WHERE topic_code = $1
          AND active = true
          AND approval_status = 'approved'
        ORDER BY random()
        LIMIT $2`,
      [topicCode, limit],
    );
    if (picked.length === 0) return { error: 'no_questions' };

    const questionIds = picked.map((q) => q.id);
    const { rows: parts } = await this.pool.query<TopicPreviewPartRow>(
      `SELECT id::text,
              question_id::text,
              part_label,
              prompt,
              marks,
              expected_response_type,
              display_order
         FROM question_parts
        WHERE question_id = ANY($1::bigint[])
        ORDER BY question_id, display_order ASC`,
      [questionIds],
    );
    const partsByQuestion = new Map<string, TopicPreviewPartRow[]>();
    for (const p of parts) {
      const list = partsByQuestion.get(p.question_id) ?? [];
      list.push(p);
      partsByQuestion.set(p.question_id, list);
    }

    const { rows: markPoints } = await this.pool.query<AttemptPartMarkPointRow>(
      `SELECT mp.id::text,
              mp.question_part_id::text,
              mp.text,
              mp.accepted_alternatives,
              mp.marks,
              mp.is_required,
              mp.display_order
         FROM mark_points mp
         JOIN question_parts qp ON qp.id = mp.question_part_id
        WHERE qp.question_id = ANY($1::bigint[])
        ORDER BY mp.display_order ASC`,
      [questionIds],
    );
    const markPointsByPart = new Map<string, AttemptPartMarkPointRow[]>();
    for (const mp of markPoints) {
      const list = markPointsByPart.get(mp.question_part_id) ?? [];
      list.push(mp);
      markPointsByPart.set(mp.question_part_id, list);
    }

    const totalMarks = picked.reduce((sum, q) => sum + q.marks_total, 0);
    let paper: PaperHeader = {
      componentCode: null,
      componentTitle: null,
      topicCode,
      topicTitle: null,
      totalMarks,
    };
    const { rows: hdr } = await this.pool.query<{
      component_code: string;
      component_title: string;
      topic_title: string;
    }>(
      `SELECT t.component_code, c.title AS component_title, t.title AS topic_title
         FROM topics t
         JOIN components c ON c.code = t.component_code
        WHERE t.code = $1`,
      [topicCode],
    );
    if (hdr[0]) {
      paper = {
        componentCode: hdr[0].component_code,
        componentTitle: hdr[0].component_title,
        topicCode,
        topicTitle: hdr[0].topic_title,
        totalMarks,
      };
    }

    // Preserve the random order chosen by the first query.
    const orderedQuestions = picked.map((q) => ({
      id: q.id,
      stem: q.stem,
      topic_code: q.topic_code,
      subtopic_code: q.subtopic_code,
      command_word_code: q.command_word_code,
      marks_total: q.marks_total,
    }));
    return { questions: orderedQuestions, partsByQuestion, markPointsByPart, paper };
  }

  async findInProgressAttemptForPupilTopic(
    pupilId: string,
    topicCode: string,
  ): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id::text
         FROM attempts
        WHERE user_id = $1::bigint
          AND target_topic_code = $2
          AND submitted_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [pupilId, topicCode],
    );
    return rows[0]?.id ?? null;
  }

  async listInProgressAttemptsForPupilTopics(
    pupilId: string,
    topicCodes: string[],
  ): Promise<Map<string, string>> {
    if (topicCodes.length === 0) return new Map();
    const { rows } = await this.pool.query<{ topic_code: string; attempt_id: string }>(
      `SELECT DISTINCT ON (target_topic_code)
              target_topic_code AS topic_code,
              id::text          AS attempt_id
         FROM attempts
        WHERE user_id = $1::bigint
          AND target_topic_code = ANY($2::text[])
          AND submitted_at IS NULL
        ORDER BY target_topic_code, started_at DESC`,
      [pupilId, topicCodes],
    );
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.topic_code, r.attempt_id);
    return out;
  }

  async findAttemptHeader(attemptId: string): Promise<AttemptRow | null> {
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT id::text, user_id::text, class_id::text, mode,
              started_at, submitted_at, target_topic_code, reveal_mode,
              timer_minutes, elapsed_seconds
         FROM attempts
        WHERE id = $1::bigint`,
      [attemptId],
    );
    return rows[0] ?? null;
  }

  async loadAttemptBundle(attemptId: string): Promise<AttemptBundle | null> {
    const attempt = await this.findAttemptHeader(attemptId);
    if (!attempt) return null;

    const { rows: questions } = await this.pool.query<AttemptQuestionRow>(
      `SELECT aq.id::text,
              aq.attempt_id::text,
              aq.question_id::text,
              aq.display_order,
              q.stem,
              q.topic_code,
              q.subtopic_code,
              q.command_word_code,
              q.marks_total,
              aq.submitted_at
         FROM attempt_questions aq
         JOIN questions q ON q.id = aq.question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY aq.display_order ASC`,
      [attemptId],
    );

    const { rows: parts } = await this.pool.query<AttemptPartRow>(
      `SELECT ap.id::text,
              ap.attempt_question_id::text,
              ap.question_part_id::text,
              qp.part_label,
              qp.prompt,
              qp.marks,
              qp.expected_response_type,
              qp.display_order,
              ap.raw_answer,
              ap.last_saved_at,
              ap.submitted_at,
              ap.pupil_self_marks
         FROM attempt_parts ap
         JOIN question_parts qp ON qp.id = ap.question_part_id
         JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY aq.display_order ASC, qp.display_order ASC`,
      [attemptId],
    );

    const { rows: markPoints } = await this.pool.query<AttemptPartMarkPointRow>(
      `SELECT mp.id::text,
              mp.question_part_id::text,
              mp.text,
              mp.accepted_alternatives,
              mp.marks,
              mp.is_required,
              mp.display_order
         FROM mark_points mp
         JOIN question_parts qp       ON qp.id = mp.question_part_id
         JOIN attempt_questions aq    ON aq.question_id = qp.question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY mp.display_order ASC`,
      [attemptId],
    );

    const { rows: awarded } = await this.pool.query<AwardedMarkRow>(
      `SELECT DISTINCT ON (am.attempt_part_id)
              am.id::text,
              am.attempt_part_id::text,
              am.marks_awarded,
              am.marks_total,
              (SELECT array_agg(x::text) FROM unnest(am.mark_points_hit) AS x) AS mark_points_hit,
              (SELECT array_agg(x::text) FROM unnest(am.mark_points_missed) AS x) AS mark_points_missed,
              am.marker,
              am.created_at
         FROM awarded_marks am
         JOIN attempt_parts ap     ON ap.id = am.attempt_part_id
         JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
        WHERE aq.attempt_id = $1::bigint
        ORDER BY am.attempt_part_id, am.created_at DESC, am.id DESC`,
      [attemptId],
    );

    const partsByQuestion = new Map<string, AttemptPartRow[]>();
    for (const p of parts) {
      const list = partsByQuestion.get(p.attempt_question_id) ?? [];
      list.push(p);
      partsByQuestion.set(p.attempt_question_id, list);
    }
    const markPointsByPart = new Map<string, AttemptPartMarkPointRow[]>();
    for (const mp of markPoints) {
      const list = markPointsByPart.get(mp.question_part_id) ?? [];
      list.push(mp);
      markPointsByPart.set(mp.question_part_id, list);
    }
    const awardedByAttemptPart = new Map<string, AwardedMarkRow>();
    for (const a of awarded) {
      awardedByAttemptPart.set(a.attempt_part_id, {
        ...a,
        mark_points_hit: a.mark_points_hit ?? [],
        mark_points_missed: a.mark_points_missed ?? [],
      });
    }

    const totalMarks = questions.reduce((sum, q) => sum + q.marks_total, 0);
    let paper: PaperHeader = {
      componentCode: null,
      componentTitle: null,
      topicCode: attempt.target_topic_code,
      topicTitle: null,
      totalMarks,
    };
    if (attempt.target_topic_code) {
      const { rows: hdr } = await this.pool.query<{
        component_code: string;
        component_title: string;
        topic_title: string;
      }>(
        `SELECT t.component_code, c.title AS component_title, t.title AS topic_title
           FROM topics t
           JOIN components c ON c.code = t.component_code
          WHERE t.code = $1`,
        [attempt.target_topic_code],
      );
      if (hdr[0]) {
        paper = {
          componentCode: hdr[0].component_code,
          componentTitle: hdr[0].component_title,
          topicCode: attempt.target_topic_code,
          topicTitle: hdr[0].topic_title,
          totalMarks,
        };
      }
    }

    return {
      attempt,
      questions,
      partsByQuestion,
      markPointsByPart,
      awardedByAttemptPart,
      paper,
    };
  }

  async saveAnswer(attemptPartId: string, rawAnswer: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE attempt_parts
          SET raw_answer = $2,
              last_saved_at = now()
        WHERE id = $1::bigint
          AND submitted_at IS NULL`,
      [attemptPartId, rawAnswer],
    );
    return rowCount ?? 0;
  }

  async markQuestionSubmitted(attemptQuestionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE attempt_questions
            SET submitted_at = now()
          WHERE id = $1::bigint
            AND submitted_at IS NULL`,
        [attemptQuestionId],
      );
      await client.query(
        `UPDATE attempt_parts
            SET submitted_at = now()
          WHERE attempt_question_id = $1::bigint
            AND submitted_at IS NULL`,
        [attemptQuestionId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async countUnsubmittedQuestions(attemptId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM attempt_questions
        WHERE attempt_id = $1::bigint
          AND submitted_at IS NULL`,
      [attemptId],
    );
    return rows[0]?.n ?? 0;
  }

  async setPupilSelfMark(attemptPartId: string, marks: number | null): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE attempt_parts
          SET pupil_self_marks = $2
        WHERE id = $1::bigint`,
      [attemptPartId, marks],
    );
    return rowCount ?? 0;
  }

  async listAttemptsForUser(userId: string): Promise<PupilAttemptSummary[]> {
    const { rows } = await this.pool.query<PupilAttemptSummary>(
      `SELECT a.id::text,
              a.target_topic_code,
              t.title AS topic_title,
              t.component_code,
              a.started_at,
              a.submitted_at,
              a.reveal_mode,
              (SELECT COUNT(*)::int
                 FROM attempt_parts ap
                 JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
                WHERE aq.attempt_id = a.id) AS total_parts,
              (SELECT COALESCE(SUM(am.marks_awarded), 0)::int
                 FROM awarded_marks am
                 JOIN attempt_parts ap     ON ap.id = am.attempt_part_id
                 JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
                WHERE aq.attempt_id = a.id
                  AND am.id = (
                    SELECT am2.id FROM awarded_marks am2
                     WHERE am2.attempt_part_id = ap.id
                     ORDER BY am2.created_at DESC, am2.id DESC
                     LIMIT 1
                  )) AS marks_awarded,
              (SELECT COALESCE(SUM(qp.marks), 0)::int
                 FROM attempt_parts ap
                 JOIN question_parts qp    ON qp.id = ap.question_part_id
                 JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
                WHERE aq.attempt_id = a.id) AS marks_total,
              (SELECT COUNT(*)::int
                 FROM attempt_parts ap
                 JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
                WHERE aq.attempt_id = a.id
                  AND NOT EXISTS (
                    SELECT 1 FROM awarded_marks am WHERE am.attempt_part_id = ap.id
                  )) AS pending_parts
         FROM attempts a
    LEFT JOIN topics t ON t.code = a.target_topic_code
        WHERE a.user_id = $1::bigint
        ORDER BY COALESCE(a.submitted_at, a.started_at) DESC`,
      [userId],
    );
    return rows;
  }

  async markSubmitted(attemptId: string, elapsedSeconds: number | null = null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE attempts
            SET submitted_at = now(),
                elapsed_seconds = COALESCE($2::int, elapsed_seconds)
          WHERE id = $1::bigint
            AND submitted_at IS NULL`,
        [attemptId, elapsedSeconds],
      );
      await client.query(
        `UPDATE attempt_parts
            SET submitted_at = now()
          WHERE submitted_at IS NULL
            AND attempt_question_id IN (
              SELECT id FROM attempt_questions WHERE attempt_id = $1::bigint
            )`,
        [attemptId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async writeDeterministicMark(input: {
    attemptPartId: string;
    marksAwarded: number;
    marksTotal: number;
    markPointsHit: string[];
    markPointsMissed: string[];
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO awarded_marks
         (attempt_part_id, marks_awarded, marks_total,
          mark_points_hit, mark_points_missed, marker, moderation_status)
       VALUES ($1::bigint, $2, $3, $4::bigint[], $5::bigint[], 'deterministic', 'not_required')`,
      [
        input.attemptPartId,
        input.marksAwarded,
        input.marksTotal,
        input.markPointsHit,
        input.markPointsMissed,
      ],
    );
  }

  async findAwardedMarkForPart(attemptPartId: string): Promise<AwardedMarkRow | null> {
    const { rows } = await this.pool.query<AwardedMarkRow>(
      `SELECT id::text, attempt_part_id::text, marks_awarded, marks_total,
              (SELECT array_agg(x::text) FROM unnest(mark_points_hit) AS x) AS mark_points_hit,
              (SELECT array_agg(x::text) FROM unnest(mark_points_missed) AS x) AS mark_points_missed,
              marker, created_at
         FROM awarded_marks
        WHERE attempt_part_id = $1::bigint
        ORDER BY created_at DESC
        LIMIT 1`,
      [attemptPartId],
    );
    return rows[0] ?? null;
  }

  async listSubmittedAttemptsForClass(classId: string): Promise<SubmittedAttemptSummary[]> {
    const { rows } = await this.pool.query<SubmittedAttemptSummary>(
      `SELECT a.id::text,
              a.user_id::text,
              u.display_name AS pupil_display_name,
              u.pseudonym AS pupil_pseudonym,
              a.target_topic_code,
              a.started_at,
              a.submitted_at,
              a.timer_minutes,
              a.elapsed_seconds,
              (SELECT COUNT(*)::int
                 FROM attempt_parts ap
                 JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
                WHERE aq.attempt_id = a.id) AS total_parts,
              (SELECT COUNT(*)::int
                 FROM attempt_parts ap
                 JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
                WHERE aq.attempt_id = a.id
                  AND NOT EXISTS (
                    SELECT 1 FROM awarded_marks am WHERE am.attempt_part_id = ap.id
                  )) AS pending_parts
         FROM attempts a
         JOIN users u ON u.id = a.user_id
        WHERE a.class_id = $1::bigint
          AND a.submitted_at IS NOT NULL
        ORDER BY a.submitted_at DESC`,
      [classId],
    );
    return rows;
  }

  async findAttemptPartContext(attemptPartId: string): Promise<AttemptPartContext | null> {
    const { rows } = await this.pool.query<AttemptPartContext>(
      `SELECT ap.id::text AS attempt_part_id,
              ap.submitted_at,
              qp.marks AS part_marks,
              qp.expected_response_type,
              a.id::text AS attempt_id,
              a.user_id::text AS pupil_id,
              a.submitted_at AS attempt_submitted_at,
              c.id::text AS class_id,
              c.teacher_id::text
         FROM attempt_parts ap
         JOIN attempt_questions aq ON aq.id = ap.attempt_question_id
         JOIN attempts a           ON a.id  = aq.attempt_id
         JOIN classes c            ON c.id  = a.class_id
         JOIN question_parts qp    ON qp.id = ap.question_part_id
        WHERE ap.id = $1::bigint`,
      [attemptPartId],
    );
    return rows[0] ?? null;
  }

  async insertTeacherOverride(input: {
    attemptPartId: string;
    teacherId: string;
    marksAwarded: number;
    marksTotal: number;
    reason: string;
  }): Promise<{ awardedMarkId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const awarded = await client.query<{ id: string }>(
        `INSERT INTO awarded_marks
           (attempt_part_id, marks_awarded, marks_total,
            mark_points_hit, mark_points_missed, marker, moderation_status)
         VALUES ($1::bigint, $2, $3, '{}'::bigint[], '{}'::bigint[],
                 'teacher_override', 'not_required')
         RETURNING id::text`,
        [input.attemptPartId, input.marksAwarded, input.marksTotal],
      );
      const awardedMarkId = awarded.rows[0]!.id;
      await client.query(
        `INSERT INTO teacher_overrides
           (awarded_mark_id, teacher_id, new_marks_awarded, reason)
         VALUES ($1::bigint, $2::bigint, $3, $4)`,
        [awardedMarkId, input.teacherId, input.marksAwarded, input.reason],
      );
      await client.query('COMMIT');
      return { awardedMarkId };
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async countOverridesForPart(attemptPartId: string): Promise<number> {
    const { rows } = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
         FROM teacher_overrides tov
         JOIN awarded_marks am ON am.id = tov.awarded_mark_id
        WHERE am.attempt_part_id = $1::bigint`,
      [attemptPartId],
    );
    return Number(rows[0]?.c ?? '0');
  }
}

export interface SubmittedAttemptSummary {
  id: string;
  user_id: string;
  pupil_display_name: string;
  pupil_pseudonym: string;
  target_topic_code: string | null;
  started_at: Date;
  submitted_at: Date;
  total_parts: number;
  pending_parts: number;
  timer_minutes: number | null;
  elapsed_seconds: number | null;
}

export interface TopicPreviewPartRow {
  id: string;
  question_id: string;
  part_label: string;
  prompt: string;
  marks: number;
  expected_response_type: string;
  display_order: number;
}

export interface TopicPreviewBundle {
  questions: Pick<
    AttemptQuestionRow,
    'id' | 'stem' | 'topic_code' | 'subtopic_code' | 'command_word_code' | 'marks_total'
  >[];
  partsByQuestion: Map<string, TopicPreviewPartRow[]>;
  markPointsByPart: Map<string, AttemptPartMarkPointRow[]>;
  paper: PaperHeader;
}

export interface PupilAttemptSummary {
  id: string;
  target_topic_code: string | null;
  topic_title: string | null;
  component_code: string | null;
  started_at: Date;
  submitted_at: Date | null;
  reveal_mode: 'per_question' | 'whole_attempt';
  total_parts: number;
  marks_awarded: number;
  marks_total: number;
  pending_parts: number;
}

export interface AttemptPartContext {
  attempt_part_id: string;
  submitted_at: Date | null;
  part_marks: number;
  expected_response_type: string;
  attempt_id: string;
  pupil_id: string;
  attempt_submitted_at: Date | null;
  class_id: string;
  teacher_id: string;
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // swallow rollback failure; original error has already propagated
  }
}
