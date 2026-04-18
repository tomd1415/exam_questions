import type { Pool, PoolClient } from 'pg';
import type { NormalisedQuestionDraft } from '../lib/question-invariants.js';

export type ApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived';

export interface QuestionPartRow {
  id: string;
  part_label: string;
  prompt: string;
  marks: number;
  expected_response_type: string;
  part_config: unknown;
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
      `SELECT id::text, part_label, prompt, marks, expected_response_type, part_config, display_order
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
      `SELECT id::text, part_label, prompt, marks, expected_response_type, part_config, display_order
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

  async findApprovalMeta(
    id: string,
  ): Promise<{ approval_status: ApprovalStatus; created_by: string; active: boolean } | null> {
    const { rows } = await this.pool.query<{
      approval_status: ApprovalStatus;
      created_by: string;
      active: boolean;
    }>(
      `SELECT approval_status, created_by::text, active
         FROM questions
        WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ?? null;
  }

  async createWithChildren(input: CreateQuestionInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = await insertQuestion(client, input);
      await insertPartsAndMarkPoints(client, id, input.parts);
      await client.query('COMMIT');
      return id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async updateWithChildren(id: string, input: CreateQuestionInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE questions
            SET component_code = $2,
                topic_code = $3,
                subtopic_code = $4,
                command_word_code = $5,
                archetype_code = $6,
                stem = $7,
                marks_total = $8,
                expected_response_type = $9,
                model_answer = $10,
                feedback_template = $11,
                difficulty_band = $12,
                difficulty_step = $13,
                source_type = $14,
                review_notes = $15,
                updated_at = now()
          WHERE id = $1::bigint`,
        [
          id,
          input.component_code,
          input.topic_code,
          input.subtopic_code,
          input.command_word_code,
          input.archetype_code,
          input.stem,
          input.marks_total,
          input.expected_response_type,
          input.model_answer,
          input.feedback_template,
          input.difficulty_band,
          input.difficulty_step,
          input.source_type,
          input.review_notes,
        ],
      );
      await upsertPartsAndMarkPoints(client, id, input.parts);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findIdBySimilarityHash(hash: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM questions WHERE similarity_hash = $1 LIMIT 1`,
      [hash],
    );
    return rows[0]?.id ?? null;
  }

  async setSimilarityHash(id: string, hash: string): Promise<void> {
    await this.pool.query(
      `UPDATE questions SET similarity_hash = $2, updated_at = now() WHERE id = $1::bigint`,
      [id, hash],
    );
  }

  async setApprovalStatus(
    id: string,
    input: {
      approval_status: ApprovalStatus;
      approved_by: string | null;
      active: boolean;
      review_notes: string | null;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE questions
          SET approval_status = $2,
              approved_by     = $3::bigint,
              active          = $4,
              review_notes    = $5,
              updated_at      = now()
        WHERE id = $1::bigint`,
      [id, input.approval_status, input.approved_by, input.active, input.review_notes],
    );
  }
}

export interface CreateQuestionInput extends NormalisedQuestionDraft {
  created_by: string;
}

async function insertQuestion(client: PoolClient, input: CreateQuestionInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO questions
       (component_code, topic_code, subtopic_code, command_word_code, archetype_code,
        stem, marks_total, expected_response_type, model_answer, feedback_template,
        difficulty_band, difficulty_step, source_type, review_notes,
        approval_status, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             'draft', false, $15::bigint)
     RETURNING id::text`,
    [
      input.component_code,
      input.topic_code,
      input.subtopic_code,
      input.command_word_code,
      input.archetype_code,
      input.stem,
      input.marks_total,
      input.expected_response_type,
      input.model_answer,
      input.feedback_template,
      input.difficulty_band,
      input.difficulty_step,
      input.source_type,
      input.review_notes,
      input.created_by,
    ],
  );
  return rows[0]!.id;
}

async function insertPartsAndMarkPoints(
  client: PoolClient,
  questionId: string,
  parts: CreateQuestionInput['parts'],
): Promise<void> {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const partRes = await client.query<{ id: string }>(
      `INSERT INTO question_parts
         (question_id, part_label, prompt, marks, expected_response_type, part_config, display_order)
       VALUES ($1::bigint, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id::text`,
      [
        questionId,
        p.part_label,
        p.prompt,
        p.marks,
        p.expected_response_type,
        partConfigParam(p.part_config),
        i + 1,
      ],
    );
    const partId = partRes.rows[0]!.id;
    for (let j = 0; j < p.mark_points.length; j++) {
      const mp = p.mark_points[j]!;
      await client.query(
        `INSERT INTO mark_points
           (question_part_id, text, accepted_alternatives, marks, is_required, display_order)
         VALUES ($1::bigint, $2, $3, $4, $5, $6)`,
        [partId, mp.text, mp.accepted_alternatives, mp.marks, mp.is_required, j + 1],
      );
    }
    for (const misc of p.misconceptions) {
      await client.query(
        `INSERT INTO common_misconceptions (question_part_id, label, description)
         VALUES ($1::bigint, $2, $3)`,
        [partId, misc.label, misc.description],
      );
    }
  }
}

// Preserves question_part.id / mark_point.id where possible by matching on
// display_order. Keeps FK-referencing rows (attempt_parts, awarded_marks) valid
// when curated content is re-seeded.
async function upsertPartsAndMarkPoints(
  client: PoolClient,
  questionId: string,
  parts: CreateQuestionInput['parts'],
): Promise<void> {
  const existing = await client.query<{ id: string; display_order: number }>(
    `SELECT id::text, display_order FROM question_parts WHERE question_id = $1::bigint`,
    [questionId],
  );
  const existingByOrder = new Map<number, string>();
  for (const r of existing.rows) existingByOrder.set(r.display_order, r.id);

  // Park existing labels under unique sentinel values so label-swaps across
  // parts don't trip the UNIQUE (question_id, part_label) constraint during
  // the update pass.
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE question_parts
          SET part_label = '__pending__' || id::text
        WHERE question_id = $1::bigint`,
      [questionId],
    );
  }

  const keepPartIds = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const displayOrder = i + 1;
    const existingId = existingByOrder.get(displayOrder);

    let partId: string;
    if (existingId) {
      await client.query(
        `UPDATE question_parts
            SET part_label = $2,
                prompt = $3,
                marks = $4,
                expected_response_type = $5,
                part_config = $6::jsonb
          WHERE id = $1::bigint`,
        [
          existingId,
          p.part_label,
          p.prompt,
          p.marks,
          p.expected_response_type,
          partConfigParam(p.part_config),
        ],
      );
      partId = existingId;
    } else {
      const partRes = await client.query<{ id: string }>(
        `INSERT INTO question_parts
           (question_id, part_label, prompt, marks, expected_response_type, part_config, display_order)
         VALUES ($1::bigint, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id::text`,
        [
          questionId,
          p.part_label,
          p.prompt,
          p.marks,
          p.expected_response_type,
          partConfigParam(p.part_config),
          displayOrder,
        ],
      );
      partId = partRes.rows[0]!.id;
    }
    keepPartIds.add(partId);

    const existingMps = await client.query<{ id: string; display_order: number }>(
      `SELECT id::text, display_order FROM mark_points WHERE question_part_id = $1::bigint`,
      [partId],
    );
    const existingMpByOrder = new Map<number, string>();
    for (const r of existingMps.rows) existingMpByOrder.set(r.display_order, r.id);
    const keepMpIds = new Set<string>();

    for (let j = 0; j < p.mark_points.length; j++) {
      const mp = p.mark_points[j]!;
      const mpOrder = j + 1;
      const existingMpId = existingMpByOrder.get(mpOrder);
      if (existingMpId) {
        await client.query(
          `UPDATE mark_points
              SET text = $2,
                  accepted_alternatives = $3,
                  marks = $4,
                  is_required = $5
            WHERE id = $1::bigint`,
          [existingMpId, mp.text, mp.accepted_alternatives, mp.marks, mp.is_required],
        );
        keepMpIds.add(existingMpId);
      } else {
        const mpRes = await client.query<{ id: string }>(
          `INSERT INTO mark_points
             (question_part_id, text, accepted_alternatives, marks, is_required, display_order)
           VALUES ($1::bigint, $2, $3, $4, $5, $6)
           RETURNING id::text`,
          [partId, mp.text, mp.accepted_alternatives, mp.marks, mp.is_required, mpOrder],
        );
        keepMpIds.add(mpRes.rows[0]!.id);
      }
    }

    const mpsToDelete = [...existingMpByOrder.values()].filter((mpid) => !keepMpIds.has(mpid));
    if (mpsToDelete.length > 0) {
      await client.query(`DELETE FROM mark_points WHERE id = ANY($1::bigint[])`, [mpsToDelete]);
    }

    // Misconceptions are not referenced by attempts — safe to wipe and re-insert.
    await client.query(`DELETE FROM common_misconceptions WHERE question_part_id = $1::bigint`, [
      partId,
    ]);
    for (const misc of p.misconceptions) {
      await client.query(
        `INSERT INTO common_misconceptions (question_part_id, label, description)
         VALUES ($1::bigint, $2, $3)`,
        [partId, misc.label, misc.description],
      );
    }
  }

  const partsToDelete = [...existingByOrder.values()].filter((pid) => !keepPartIds.has(pid));
  if (partsToDelete.length > 0) {
    await client.query(`DELETE FROM question_parts WHERE id = ANY($1::bigint[])`, [partsToDelete]);
  }
}

// Serialise a part_config value for the JSONB column. NULL/undefined map
// to a real SQL NULL so the column predicate `part_config IS NULL`
// behaves intuitively, rather than storing the JSON literal "null".
function partConfigParam(config: unknown): string | null {
  if (config === null || config === undefined) return null;
  return JSON.stringify(config);
}
