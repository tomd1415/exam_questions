import type { Pool } from 'pg';

export interface TopicRow {
  code: string;
  component_code: string;
  title: string;
  display_order: number;
}

export class CurriculumRepo {
  constructor(private readonly pool: Pool) {}

  async listTopics(): Promise<TopicRow[]> {
    const { rows } = await this.pool.query<TopicRow>(
      `SELECT code, component_code, title, display_order
         FROM topics
        ORDER BY component_code ASC, display_order ASC`,
    );
    return rows;
  }
}
