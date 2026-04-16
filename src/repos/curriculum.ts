import type { Pool } from 'pg';
import type { QuestionDraftReferenceData } from '../lib/question-invariants.js';

export interface ComponentRow {
  code: string;
  title: string;
}

export interface TopicRow {
  code: string;
  component_code: string;
  title: string;
  display_order: number;
}

export interface SubtopicRow {
  code: string;
  topic_code: string;
  title: string;
  display_order: number;
}

export interface CommandWordRow {
  code: string;
  definition: string;
  expected_response_shape: string;
}

export interface ArchetypeRow {
  code: string;
  description: string;
}

export class CurriculumRepo {
  constructor(private readonly pool: Pool) {}

  async listComponents(): Promise<ComponentRow[]> {
    const { rows } = await this.pool.query<ComponentRow>(
      `SELECT code, title FROM components ORDER BY code ASC`,
    );
    return rows;
  }

  async listTopics(): Promise<TopicRow[]> {
    const { rows } = await this.pool.query<TopicRow>(
      `SELECT code, component_code, title, display_order
         FROM topics
        ORDER BY component_code ASC, display_order ASC`,
    );
    return rows;
  }

  async listSubtopics(): Promise<SubtopicRow[]> {
    const { rows } = await this.pool.query<SubtopicRow>(
      `SELECT code, topic_code, title, display_order
         FROM subtopics
        ORDER BY topic_code ASC, display_order ASC`,
    );
    return rows;
  }

  async listCommandWords(): Promise<CommandWordRow[]> {
    const { rows } = await this.pool.query<CommandWordRow>(
      `SELECT code, definition, expected_response_shape
         FROM command_words
        ORDER BY code ASC`,
    );
    return rows;
  }

  async listArchetypes(): Promise<ArchetypeRow[]> {
    const { rows } = await this.pool.query<ArchetypeRow>(
      `SELECT code, description FROM question_archetypes ORDER BY code ASC`,
    );
    return rows;
  }

  async getReferenceData(): Promise<QuestionDraftReferenceData> {
    const [components, topics, subtopics, commandWords, archetypes] = await Promise.all([
      this.listComponents(),
      this.listTopics(),
      this.listSubtopics(),
      this.listCommandWords(),
      this.listArchetypes(),
    ]);
    return {
      components: new Set(components.map((c) => c.code)),
      commandWords: new Set(commandWords.map((c) => c.code)),
      archetypes: new Set(archetypes.map((a) => a.code)),
      topicComponent: new Map(topics.map((t) => [t.code, t.component_code])),
      subtopicTopic: new Map(subtopics.map((s) => [s.code, s.topic_code])),
    };
  }
}
