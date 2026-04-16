import type { Pool } from 'pg';

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
}
