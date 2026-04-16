import type { Pool, PoolClient } from 'pg';

export interface SavedAttempt {
  attempt_id: string;
  attempt_question_id: string;
  part_ids: string[];
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
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // swallow rollback failure; original error has already propagated
  }
}
