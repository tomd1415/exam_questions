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

export interface AttemptBundle {
  attempt: AttemptRow;
  questions: AttemptQuestionRow[];
  partsByQuestion: Map<string, AttemptPartRow[]>;
  markPointsByPart: Map<string, AttemptPartMarkPointRow[]>;
  awardedByAttemptPart: Map<string, AwardedMarkRow>;
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
        `INSERT INTO attempts (user_id, class_id, mode, target_topic_code)
           VALUES ($1::bigint, $2::bigint, 'topic_set', $3)
         RETURNING id::text`,
        [input.userId, input.classId, input.topicCode],
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

  async findAttemptHeader(attemptId: string): Promise<AttemptRow | null> {
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT id::text, user_id::text, class_id::text, mode,
              started_at, submitted_at, target_topic_code
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
              q.marks_total
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
              ap.submitted_at
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
      `SELECT am.id::text,
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
        WHERE aq.attempt_id = $1::bigint`,
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

    return { attempt, questions, partsByQuestion, markPointsByPart, awardedByAttemptPart };
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

  async markSubmitted(attemptId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE attempts
            SET submitted_at = now()
          WHERE id = $1::bigint
            AND submitted_at IS NULL`,
        [attemptId],
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
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // swallow rollback failure; original error has already propagated
  }
}
