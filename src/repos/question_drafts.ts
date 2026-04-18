import type { Pool } from 'pg';
import type { QuestionDraft } from '../lib/question-invariants.js';

// The wizard accumulates a partial QuestionDraft across nine steps. At step 9
// the payload must validate as a full QuestionDraft (the same shape the
// existing /admin/questions form already produces) so QuestionService can
// publish it through the same insert path as the seeder. While the wizard is
// in flight, every field is optional — a teacher who has only completed step
// 1 has just a topic / subtopic, nothing else.
//
// The payload shape is intentionally a *subset* of QuestionDraft (not its
// own shape) so there is no second canonical schema to keep in sync. Wizard
// steps map cleanly:
//   step 1 → component_code, topic_code, subtopic_code
//   step 2 → command_word_code (+ archetype_code, picked from a tariff hint)
//   step 3 → expected_response_type (the widget the teacher chose)
//   step 4 → parts[].part_config (+ widget-specific structure)
//   step 5 → stem
//   step 6 → parts[].marks, parts[].mark_points, model_answer
//   step 7 → parts[].misconceptions
//   step 8 → difficulty_band, difficulty_step, source_type, …
//   step 9 → review only; publish builds the final QuestionDraft and hands
//            it to QuestionService.createDraft.

export type QuestionDraftPayload = Partial<QuestionDraft>;

export interface QuestionDraftRow {
  id: string;
  author_user_id: string;
  current_step: number;
  payload: QuestionDraftPayload;
  published_question_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionDraftListRow {
  id: string;
  current_step: number;
  payload: QuestionDraftPayload;
  published_question_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id::text,
  author_user_id::text,
  current_step,
  payload,
  published_question_id::text,
  created_at,
  updated_at
`;

export class QuestionDraftRepo {
  constructor(private readonly pool: Pool) {}

  async create(authorUserId: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO question_drafts (author_user_id)
       VALUES ($1::bigint)
       RETURNING id::text`,
      [authorUserId],
    );
    return rows[0]!.id;
  }

  async findById(id: string): Promise<QuestionDraftRow | null> {
    const { rows } = await this.pool.query<QuestionDraftRow>(
      `SELECT ${SELECT_COLUMNS} FROM question_drafts WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listByAuthor(authorUserId: string): Promise<QuestionDraftListRow[]> {
    const { rows } = await this.pool.query<QuestionDraftListRow>(
      `SELECT id::text, current_step, payload, published_question_id::text, created_at, updated_at
         FROM question_drafts
        WHERE author_user_id = $1::bigint
        ORDER BY updated_at DESC`,
      [authorUserId],
    );
    return rows;
  }

  // Replaces the payload wholesale with the merged version the service hands
  // in, and bumps current_step to whichever step has now been completed.
  // current_step is monotonic — the service guarantees we never call this
  // with a step lower than the one stored, so a resume-on-step-3 then jump-to
  // step-5 cannot rewind progress.
  async update(
    id: string,
    input: { current_step: number; payload: QuestionDraftPayload },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE question_drafts
          SET current_step = $2,
              payload      = $3::jsonb,
              updated_at   = now()
        WHERE id = $1::bigint`,
      [id, input.current_step, JSON.stringify(input.payload)],
    );
  }

  // Sets the FK to the live questions row created by publish, locking the
  // draft from further advance. Setting twice is a programmer error, not a
  // user error, so the service guards on it before calling here.
  async markPublished(id: string, publishedQuestionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE question_drafts
          SET published_question_id = $2::bigint,
              updated_at            = now()
        WHERE id = $1::bigint`,
      [id, publishedQuestionId],
    );
  }
}
