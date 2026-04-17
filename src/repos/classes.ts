import type { Pool } from 'pg';

export interface ClassRow {
  id: string;
  name: string;
  teacher_id: string;
  academic_year: string;
  active: boolean;
  topic_set_size: number;
  timer_minutes: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface AssignedTopicRow {
  topic_code: string;
  topic_title: string;
  component_code: string;
  assigned_by_display_name: string;
  created_at: Date;
}

export interface ClassWithTeacherRow extends ClassRow {
  teacher_display_name: string;
  teacher_username: string;
}

export interface EnrolledPupilRow {
  user_id: string;
  display_name: string;
  username: string;
  pseudonym: string;
  active: boolean;
  enrolled_at: Date;
}

const CLASS_COLUMNS = `
  id::text,
  name,
  teacher_id::text,
  academic_year,
  active,
  topic_set_size,
  timer_minutes,
  created_at,
  updated_at
`;

export class ClassRepo {
  constructor(private readonly pool: Pool) {}

  async createClass(input: {
    name: string;
    teacherId: string;
    academicYear: string;
  }): Promise<ClassRow> {
    const { rows } = await this.pool.query<ClassRow>(
      `INSERT INTO classes (name, teacher_id, academic_year)
       VALUES ($1, $2::bigint, $3)
       RETURNING ${CLASS_COLUMNS}`,
      [input.name, input.teacherId, input.academicYear],
    );
    return rows[0]!;
  }

  async findById(id: string): Promise<ClassRow | null> {
    const { rows } = await this.pool.query<ClassRow>(
      `SELECT ${CLASS_COLUMNS} FROM classes WHERE id = $1::bigint`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listForTeacher(teacherId: string): Promise<ClassRow[]> {
    const { rows } = await this.pool.query<ClassRow>(
      `SELECT ${CLASS_COLUMNS}
         FROM classes
        WHERE teacher_id = $1::bigint
        ORDER BY active DESC, academic_year DESC, name ASC`,
      [teacherId],
    );
    return rows;
  }

  async listAllWithTeacher(): Promise<ClassWithTeacherRow[]> {
    const { rows } = await this.pool.query<ClassWithTeacherRow>(
      `SELECT ${CLASS_COLUMNS.split(',')
        .map((c) => `c.${c.trim()}`)
        .join(', ')},
              u.display_name AS teacher_display_name,
              u.username     AS teacher_username
         FROM classes c
         JOIN users   u ON u.id = c.teacher_id
        ORDER BY c.active DESC, c.academic_year DESC, c.name ASC`,
    );
    return rows;
  }

  async addEnrolment(classId: string, userId: string): Promise<'added' | 'already'> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO enrolments (class_id, user_id)
       VALUES ($1::bigint, $2::bigint)
       ON CONFLICT DO NOTHING`,
      [classId, userId],
    );
    return rowCount === 0 ? 'already' : 'added';
  }

  async removeEnrolment(classId: string, userId: string): Promise<'removed' | 'not_enrolled'> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM enrolments WHERE class_id = $1::bigint AND user_id = $2::bigint`,
      [classId, userId],
    );
    return rowCount === 0 ? 'not_enrolled' : 'removed';
  }

  async listPupilsInClass(classId: string): Promise<EnrolledPupilRow[]> {
    const { rows } = await this.pool.query<EnrolledPupilRow>(
      `SELECT u.id::text AS user_id,
              u.display_name,
              u.username,
              u.pseudonym,
              u.active,
              e.created_at AS enrolled_at
         FROM enrolments e
         JOIN users u ON u.id = e.user_id
        WHERE e.class_id = $1::bigint
        ORDER BY u.display_name ASC`,
      [classId],
    );
    return rows;
  }

  async findPupilByUsername(
    username: string,
  ): Promise<{ id: string; display_name: string } | null> {
    const { rows } = await this.pool.query<{ id: string; display_name: string }>(
      `SELECT id::text, display_name
         FROM users
        WHERE username = $1 AND role = 'pupil' AND active = true`,
      [username],
    );
    return rows[0] ?? null;
  }

  async assignTopic(
    classId: string,
    topicCode: string,
    assignedBy: string,
  ): Promise<'added' | 'already'> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO class_assigned_topics (class_id, topic_code, assigned_by)
       VALUES ($1::bigint, $2, $3::bigint)
       ON CONFLICT DO NOTHING`,
      [classId, topicCode, assignedBy],
    );
    return rowCount === 0 ? 'already' : 'added';
  }

  async unassignTopic(classId: string, topicCode: string): Promise<'removed' | 'not_assigned'> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM class_assigned_topics WHERE class_id = $1::bigint AND topic_code = $2`,
      [classId, topicCode],
    );
    return rowCount === 0 ? 'not_assigned' : 'removed';
  }

  async listAssignedTopics(classId: string): Promise<AssignedTopicRow[]> {
    const { rows } = await this.pool.query<AssignedTopicRow>(
      `SELECT cat.topic_code,
              t.title AS topic_title,
              t.component_code,
              u.display_name AS assigned_by_display_name,
              cat.created_at
         FROM class_assigned_topics cat
         JOIN topics t ON t.code = cat.topic_code
         JOIN users  u ON u.id   = cat.assigned_by
        WHERE cat.class_id = $1::bigint
        ORDER BY t.component_code ASC, cat.topic_code ASC`,
      [classId],
    );
    return rows;
  }

  async listAssignedTopicsForPupil(pupilId: string): Promise<AssignedTopicRow[]> {
    const { rows } = await this.pool.query<AssignedTopicRow>(
      `SELECT DISTINCT cat.topic_code,
              t.title AS topic_title,
              t.component_code,
              u.display_name AS assigned_by_display_name,
              cat.created_at
         FROM class_assigned_topics cat
         JOIN topics     t ON t.code = cat.topic_code
         JOIN users      u ON u.id   = cat.assigned_by
         JOIN enrolments e ON e.class_id = cat.class_id
        WHERE e.user_id = $1::bigint
        ORDER BY t.component_code ASC, cat.topic_code ASC`,
      [pupilId],
    );
    return rows;
  }

  async findClassForPupilAndTopic(
    pupilId: string,
    topicCode: string,
  ): Promise<{ class_id: string; topic_set_size: number; timer_minutes: number | null } | null> {
    const { rows } = await this.pool.query<{
      class_id: string;
      topic_set_size: number;
      timer_minutes: number | null;
    }>(
      `SELECT c.id::text AS class_id, c.topic_set_size, c.timer_minutes
         FROM classes c
         JOIN enrolments e            ON e.class_id = c.id
         JOIN class_assigned_topics t ON t.class_id = c.id
        WHERE e.user_id = $1::bigint AND t.topic_code = $2
        ORDER BY c.id
        LIMIT 1`,
      [pupilId, topicCode],
    );
    return rows[0] ?? null;
  }

  async updateClassTimer(classId: string, minutes: number | null): Promise<ClassRow | null> {
    const { rows } = await this.pool.query<ClassRow>(
      `UPDATE classes
          SET timer_minutes = $2,
              updated_at    = now()
        WHERE id = $1::bigint
        RETURNING ${CLASS_COLUMNS}`,
      [classId, minutes],
    );
    return rows[0] ?? null;
  }
}
