import type { Pool } from 'pg';

export type ApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived';

export interface QuestionPartRow {
  id: string;
  part_label: string;
  prompt: string;
  marks: number;
  expected_response_type: string;
  display_order: number;
}

export interface QuestionRow {
  id: string;
  stem: string;
  marks_total: number;
  topic_code: string;
  subtopic_code: string;
  command_word_code: string;
  parts: QuestionPartRow[];
}

export interface QuestionListRow {
  id: string;
  stem: string;
  topic_code: string;
  topic_title: string;
  subtopic_code: string;
  command_word_code: string;
  marks_total: number;
  approval_status: ApprovalStatus;
  active: boolean;
  created_by_display_name: string;
  updated_at: Date;
}

export interface QuestionDetailRow {
  id: string;
  component_code: string;
  topic_code: string;
  topic_title: string;
  subtopic_code: string;
  subtopic_title: string;
  command_word_code: string;
  archetype_code: string;
  stem: string;
  marks_total: number;
  expected_response_type: string;
  model_answer: string;
  feedback_template: string | null;
  difficulty_band: number;
  difficulty_step: number;
  source_type: 'teacher' | 'imported_pattern' | 'ai_generated';
  approval_status: ApprovalStatus;
  active: boolean;
  review_notes: string | null;
  created_by_display_name: string;
  approved_by_display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MarkPointRow {
  id: string;
  question_part_id: string;
  text: string;
  accepted_alternatives: string[];
  marks: number;
  is_required: boolean;
  display_order: number;
}

export interface MisconceptionRow {
  id: string;
  question_part_id: string | null;
  topic_code: string | null;
  label: string;
  description: string;
}

export interface QuestionWithChildrenRow {
  question: QuestionDetailRow;
  parts: QuestionPartRow[];
  markPointsByPart: Map<string, MarkPointRow[]>;
  misconceptionsByPart: Map<string, MisconceptionRow[]>;
  topicMisconceptions: MisconceptionRow[];
}

export interface ListQuestionsFilters {
  topic?: string;
  approvalStatus?: ApprovalStatus;
  active?: boolean;
}

export class QuestionRepo {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<QuestionRow | null> {
    const qRes = await this.pool.query<{
      id: string;
      stem: string;
      marks_total: number;
      topic_code: string;
      subtopic_code: string;
      command_word_code: string;
    }>(
      `SELECT id::text, stem, marks_total, topic_code, subtopic_code, command_word_code
         FROM questions
        WHERE id = $1::bigint AND active = true`,
      [id],
    );
    const q = qRes.rows[0];
    if (!q) return null;

    const partsRes = await this.pool.query<QuestionPartRow>(
      `SELECT id::text, part_label, prompt, marks, expected_response_type, display_order
         FROM question_parts
        WHERE question_id = $1::bigint
        ORDER BY display_order`,
      [id],
    );

    return { ...q, parts: partsRes.rows };
  }

  async listQuestions(filters: ListQuestionsFilters = {}): Promise<QuestionListRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.topic !== undefined) {
      params.push(filters.topic);
      where.push(`q.topic_code = $${params.length}`);
    }
    if (filters.approvalStatus !== undefined) {
      params.push(filters.approvalStatus);
      where.push(`q.approval_status = $${params.length}`);
    }
    if (filters.active !== undefined) {
      params.push(filters.active);
      where.push(`q.active = $${params.length}`);
    }
    const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

    const { rows } = await this.pool.query<QuestionListRow>(
      `SELECT q.id::text,
              q.stem,
              q.topic_code,
              t.title       AS topic_title,
              q.subtopic_code,
              q.command_word_code,
              q.marks_total,
              q.approval_status,
              q.active,
              u.display_name AS created_by_display_name,
              q.updated_at
         FROM questions q
         JOIN topics t ON t.code = q.topic_code
         JOIN users  u ON u.id   = q.created_by
        ${whereSql}
        ORDER BY q.topic_code ASC, q.subtopic_code ASC, q.id ASC`,
      params,
    );
    return rows;
  }

  async getQuestionWithPartsAndMarkPoints(id: string): Promise<QuestionWithChildrenRow | null> {
    const qRes = await this.pool.query<QuestionDetailRow>(
      `SELECT q.id::text,
              q.component_code,
              q.topic_code,
              t.title       AS topic_title,
              q.subtopic_code,
              s.title       AS subtopic_title,
              q.command_word_code,
              q.archetype_code,
              q.stem,
              q.marks_total,
              q.expected_response_type,
              q.model_answer,
              q.feedback_template,
              q.difficulty_band,
              q.difficulty_step,
              q.source_type,
              q.approval_status,
              q.active,
              q.review_notes,
              cu.display_name AS created_by_display_name,
              au.display_name AS approved_by_display_name,
              q.created_at,
              q.updated_at
         FROM questions q
         JOIN topics    t  ON t.code = q.topic_code
         JOIN subtopics s  ON s.code = q.subtopic_code
         JOIN users     cu ON cu.id  = q.created_by
         LEFT JOIN users au ON au.id = q.approved_by
        WHERE q.id = $1::bigint`,
      [id],
    );
    const question = qRes.rows[0];
    if (!question) return null;

    const partsRes = await this.pool.query<QuestionPartRow>(
      `SELECT id::text, part_label, prompt, marks, expected_response_type, display_order
         FROM question_parts
        WHERE question_id = $1::bigint
        ORDER BY display_order`,
      [id],
    );
    const parts = partsRes.rows;
    const partIds = parts.map((p) => p.id);

    const markPointsByPart = new Map<string, MarkPointRow[]>();
    const misconceptionsByPart = new Map<string, MisconceptionRow[]>();
    for (const p of parts) {
      markPointsByPart.set(p.id, []);
      misconceptionsByPart.set(p.id, []);
    }

    if (partIds.length > 0) {
      const mpRes = await this.pool.query<MarkPointRow>(
        `SELECT id::text,
                question_part_id::text,
                text,
                accepted_alternatives,
                marks,
                is_required,
                display_order
           FROM mark_points
          WHERE question_part_id = ANY($1::bigint[])
          ORDER BY question_part_id, display_order`,
        [partIds],
      );
      for (const mp of mpRes.rows) {
        markPointsByPart.get(mp.question_part_id)?.push(mp);
      }

      const miscRes = await this.pool.query<MisconceptionRow>(
        `SELECT id::text,
                question_part_id::text AS question_part_id,
                topic_code,
                label,
                description
           FROM common_misconceptions
          WHERE question_part_id = ANY($1::bigint[])
          ORDER BY question_part_id, id`,
        [partIds],
      );
      for (const m of miscRes.rows) {
        if (m.question_part_id) misconceptionsByPart.get(m.question_part_id)?.push(m);
      }
    }

    const topicMiscRes = await this.pool.query<MisconceptionRow>(
      `SELECT id::text,
              NULL::text AS question_part_id,
              topic_code,
              label,
              description
         FROM common_misconceptions
        WHERE question_part_id IS NULL AND topic_code = $1
        ORDER BY id`,
      [question.topic_code],
    );

    return {
      question,
      parts,
      markPointsByPart,
      misconceptionsByPart,
      topicMisconceptions: topicMiscRes.rows,
    };
  }
}
