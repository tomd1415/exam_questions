import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword } from '../../src/lib/passwords.js';
import type { UserRole } from '../../src/repos/users.js';

export interface CreatedUser {
  id: string;
  username: string;
  password: string;
  role: UserRole;
  display_name: string;
}

export async function createUser(
  pool: Pool,
  overrides: Partial<{
    role: UserRole;
    username: string;
    password: string;
    displayName: string;
    active: boolean;
    pseudonym: string;
    mustChangePassword: boolean;
    failedLoginCount: number;
    lockedUntil: Date | null;
  }> = {},
): Promise<CreatedUser> {
  const suffix = randomBytes(4).toString('hex');
  const role: UserRole = overrides.role ?? 'pupil';
  const username = overrides.username ?? `${role}_${suffix}`;
  const password = overrides.password ?? 'correct horse battery staple';
  const displayName = overrides.displayName ?? `Test ${role} ${suffix}`;
  const pseudonym = overrides.pseudonym ?? `PSEUDO-${suffix.toUpperCase()}`;
  const active = overrides.active ?? true;
  const mustChange = overrides.mustChangePassword ?? false;
  const failedCount = overrides.failedLoginCount ?? 0;
  const lockedUntil = overrides.lockedUntil ?? null;

  const passwordHash = await hashPassword(password);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password,
        failed_login_count, locked_until, active, pseudonym)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id::text`,
    [
      role,
      displayName,
      username,
      passwordHash,
      mustChange,
      failedCount,
      lockedUntil,
      active,
      pseudonym,
    ],
  );

  return { id: rows[0]!.id, username, password, role, display_name: displayName };
}

export interface CreatedQuestion {
  id: string;
  topicCode: string;
  subtopicCode: string;
  commandWordCode: string;
  approvalStatus: string;
  active: boolean;
  marksTotal: number;
}

export async function createQuestion(
  pool: Pool,
  createdByUserId: string,
  overrides: Partial<{
    componentCode: string;
    topicCode: string;
    subtopicCode: string;
    commandWordCode: string;
    archetypeCode: string;
    stem: string;
    marksTotal: number;
    expectedResponseType: string;
    modelAnswer: string;
    difficultyBand: number;
    difficultyStep: number;
    sourceType: 'teacher' | 'imported_pattern' | 'ai_generated';
    approvalStatus: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived';
    active: boolean;
    parts: {
      label: string;
      prompt: string;
      marks: number;
      expectedResponseType: string;
      partConfig?: unknown;
      markPoints?: {
        text: string;
        acceptedAlternatives?: string[];
        marks?: number;
        isRequired?: boolean;
      }[];
    }[];
  }> = {},
): Promise<CreatedQuestion> {
  const componentCode = overrides.componentCode ?? 'J277/01';
  const topicCode = overrides.topicCode ?? '1.1';
  const subtopicCode = overrides.subtopicCode ?? '1.1.1';
  const commandWordCode = overrides.commandWordCode ?? 'describe';
  const archetypeCode = overrides.archetypeCode ?? 'explain';
  const stem = overrides.stem ?? `Test question ${randomBytes(4).toString('hex')}`;
  const expectedResponseType = overrides.expectedResponseType ?? 'short_text';
  const modelAnswer = overrides.modelAnswer ?? 'A model answer.';
  const difficultyBand = overrides.difficultyBand ?? 3;
  const difficultyStep = overrides.difficultyStep ?? 1;
  const sourceType = overrides.sourceType ?? 'teacher';
  const approvalStatus = overrides.approvalStatus ?? 'draft';
  const active = overrides.active ?? false;
  const parts = overrides.parts ?? [
    { label: '(a)', prompt: 'Describe the thing.', marks: 2, expectedResponseType: 'short_text' },
  ];
  const marksTotal = overrides.marksTotal ?? parts.reduce((s, p) => s + p.marks, 0);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO questions
       (component_code, topic_code, subtopic_code, command_word_code, archetype_code,
        stem, marks_total, expected_response_type, model_answer,
        difficulty_band, difficulty_step, source_type,
        approval_status, active, created_by, approved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::bigint,
             CASE WHEN $13 = 'approved' THEN $15::bigint ELSE NULL END)
     RETURNING id::text`,
    [
      componentCode,
      topicCode,
      subtopicCode,
      commandWordCode,
      archetypeCode,
      stem,
      marksTotal,
      expectedResponseType,
      modelAnswer,
      difficultyBand,
      difficultyStep,
      sourceType,
      approvalStatus,
      active,
      createdByUserId,
    ],
  );
  const questionId = rows[0]!.id;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const partRes = await pool.query<{ id: string }>(
      `INSERT INTO question_parts
         (question_id, part_label, prompt, marks, expected_response_type, part_config, display_order)
       VALUES ($1::bigint, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id::text`,
      [
        questionId,
        p.label,
        p.prompt,
        p.marks,
        p.expectedResponseType,
        p.partConfig === undefined || p.partConfig === null ? null : JSON.stringify(p.partConfig),
        i + 1,
      ],
    );
    const partId = partRes.rows[0]!.id;
    const markPoints = p.markPoints ?? [];
    for (let j = 0; j < markPoints.length; j++) {
      const mp = markPoints[j]!;
      await pool.query(
        `INSERT INTO mark_points
           (question_part_id, text, accepted_alternatives, marks, is_required, display_order)
         VALUES ($1::bigint, $2, $3, $4, $5, $6)`,
        [
          partId,
          mp.text,
          mp.acceptedAlternatives ?? [],
          mp.marks ?? 1,
          mp.isRequired ?? false,
          j + 1,
        ],
      );
    }
  }

  return {
    id: questionId,
    topicCode,
    subtopicCode,
    commandWordCode,
    approvalStatus,
    active,
    marksTotal,
  };
}
