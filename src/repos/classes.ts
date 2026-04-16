import type { Pool } from 'pg';

export interface ClassRow {
  id: string;
  name: string;
  teacher_id: string;
  academic_year: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
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
}
