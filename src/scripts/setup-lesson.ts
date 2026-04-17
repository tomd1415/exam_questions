/**
 * One-shot lesson setup for the Phase 1 classroom test.
 *
 *   npm run setup:lesson
 *
 * Idempotent. Safe to re-run; existing rows are updated, not duplicated.
 *
 * Creates:
 *   - synthetic pupils pupil1..pupil<COUNT> (passwords password-001..password-0NN)
 *   - class "Phase 1 Lesson Test" owned by the teacher (default username 'tom')
 *   - enrolments for every synthetic pupil
 *   - topic assignment (default 2.1)
 *
 * Environment overrides (all optional):
 *   LESSON_TEACHER_USERNAME        default 'tom'
 *   LESSON_TEACHER_PASSWORD        if set AND the teacher does not exist, create them
 *   LESSON_TEACHER_DISPLAY_NAME    default 'Class Teacher'
 *   LESSON_TEACHER_PSEUDONYM       default 'TEA-0001'
 *   LESSON_CLASS_NAME              default 'Phase 1 Lesson Test'
 *   LESSON_ACADEMIC_YEAR           default '2025-26'
 *   LESSON_TOPIC_CODE              default '2.1'
 *   LESSON_PUPIL_COUNT             default 20
 */
import { pool } from '../db/pool.js';
import { hashPassword } from '../lib/passwords.js';
import { UserRepo } from '../repos/users.js';
import { ClassRepo } from '../repos/classes.js';
import { AuditRepo } from '../repos/audit.js';
import { AuditService } from '../services/audit.js';
import { ClassService } from '../services/classes.js';

const TEACHER_USERNAME = process.env['LESSON_TEACHER_USERNAME'] ?? 'tom';
const TEACHER_PASSWORD = process.env['LESSON_TEACHER_PASSWORD'] ?? '';
const TEACHER_DISPLAY_NAME = process.env['LESSON_TEACHER_DISPLAY_NAME'] ?? 'Class Teacher';
const TEACHER_PSEUDONYM = process.env['LESSON_TEACHER_PSEUDONYM'] ?? 'TEA-0001';
const CLASS_NAME = process.env['LESSON_CLASS_NAME'] ?? 'Phase 1 Lesson Test';
const ACADEMIC_YEAR = process.env['LESSON_ACADEMIC_YEAR'] ?? '2025-26';
const TOPIC_CODE = process.env['LESSON_TOPIC_CODE'] ?? '2.1';
const PUPIL_COUNT = Number(process.env['LESSON_PUPIL_COUNT'] ?? '20');

function pupilPassword(n: number): string {
  return `password-${String(n).padStart(3, '0')}`;
}

function pupilPseudonym(n: number): string {
  return `SYN-PUP-${String(n).padStart(3, '0')}`;
}

async function upsertPupil(n: number): Promise<void> {
  const username = `pupil${n}`;
  const displayName = `Synthetic Pupil ${n}`;
  const pseudonym = pupilPseudonym(n);
  const passwordHash = await hashPassword(pupilPassword(n));
  await pool.query(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password, pseudonym, active)
     VALUES ('pupil', $1, $2, $3, false, $4, true)
     ON CONFLICT (username) DO UPDATE
       SET role                 = 'pupil',
           display_name         = EXCLUDED.display_name,
           password_hash        = EXCLUDED.password_hash,
           must_change_password = false,
           active               = true,
           updated_at           = now()`,
    [displayName, username, passwordHash, pseudonym],
  );
}

async function findOrCreateClass(
  classes: ClassService,
  actor: { id: string; role: 'teacher' | 'admin' },
): Promise<{ id: string; created: boolean }> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM classes WHERE name = $1 AND academic_year = $2 AND teacher_id = $3::bigint LIMIT 1`,
    [CLASS_NAME, ACADEMIC_YEAR, actor.id],
  );
  if (existing.rows.length > 0) {
    return { id: existing.rows[0]!.id, created: false };
  }
  const row = await classes.createClass(actor, { name: CLASS_NAME, academicYear: ACADEMIC_YEAR });
  return { id: row.id, created: true };
}

async function main(): Promise<void> {
  if (!Number.isFinite(PUPIL_COUNT) || PUPIL_COUNT < 1 || PUPIL_COUNT > 200) {
    throw new Error(`LESSON_PUPIL_COUNT must be an integer 1..200 (got ${PUPIL_COUNT})`);
  }

  const userRepo = new UserRepo(pool);
  const classRepo = new ClassRepo(pool);
  const auditRepo = new AuditRepo(pool);
  const auditService = new AuditService(auditRepo);
  const classService = new ClassService(classRepo, auditService);

  let teacher = await userRepo.findByUsername(TEACHER_USERNAME);
  if (!teacher) {
    if (!TEACHER_PASSWORD) {
      throw new Error(
        `Teacher account '${TEACHER_USERNAME}' not found. Set LESSON_TEACHER_PASSWORD to auto-create it, or run: npm run user:create -- --role teacher --username ${TEACHER_USERNAME} --display-name "Your Name" --pseudonym TEA-0001 --password '<12+ chars>' --no-force-change`,
      );
    }
    if (TEACHER_PASSWORD.length < 12) {
      throw new Error('LESSON_TEACHER_PASSWORD must be at least 12 characters.');
    }
    const passwordHash = await hashPassword(TEACHER_PASSWORD);
    await pool.query(
      `INSERT INTO users
         (role, display_name, username, password_hash, must_change_password, pseudonym, active)
       VALUES ('teacher', $1, $2, $3, false, $4, true)`,
      [TEACHER_DISPLAY_NAME, TEACHER_USERNAME, passwordHash, TEACHER_PSEUDONYM],
    );
    console.log(`  ✓ created teacher '${TEACHER_USERNAME}' (pseudonym ${TEACHER_PSEUDONYM})`);
    teacher = await userRepo.findByUsername(TEACHER_USERNAME);
    if (!teacher) throw new Error('Teacher creation succeeded but lookup returned nothing.');
  }
  if (teacher.role !== 'teacher' && teacher.role !== 'admin') {
    throw new Error(
      `User '${TEACHER_USERNAME}' has role '${teacher.role}'; must be teacher or admin.`,
    );
  }

  console.log(`Teacher: ${teacher.username} (${teacher.role})`);
  console.log(`Creating ${PUPIL_COUNT} synthetic pupils...`);
  for (let n = 1; n <= PUPIL_COUNT; n++) {
    await upsertPupil(n);
  }
  console.log(`  ✓ pupils pupil1..pupil${PUPIL_COUNT} ready`);

  const actor = { id: teacher.id, role: teacher.role };
  const { id: classId, created } = await findOrCreateClass(classService, actor);
  console.log(`Class: "${CLASS_NAME}" (id=${classId}) [${created ? 'created' : 'reused'}]`);

  let enrolledAdded = 0;
  let enrolledAlready = 0;
  for (let n = 1; n <= PUPIL_COUNT; n++) {
    const result = await classService.enrolPupilByUsername(actor, classId, `pupil${n}`);
    if (result.status === 'added') enrolledAdded++;
    else enrolledAlready++;
  }
  console.log(`  ✓ enrolments: ${enrolledAdded} added, ${enrolledAlready} already present`);

  const topicStatus = await classService.assignTopic(actor, classId, TOPIC_CODE);
  console.log(
    `  ✓ topic ${TOPIC_CODE}: ${topicStatus === 'added' ? 'assigned' : 'already assigned'}`,
  );

  console.log('');
  console.log('Login credentials for today:');
  console.log(`  Teacher: ${TEACHER_USERNAME} / <your password>`);
  for (let n = 1; n <= PUPIL_COUNT; n++) {
    console.log(`  pupil${n} / ${pupilPassword(n)}`);
  }
  console.log('');
  console.log(`Class URL (teacher view): /admin/classes/${classId}`);
  console.log(`Pupils sign in, then click "Start topic set" next to topic ${TOPIC_CODE}.`);
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await pool.end();
    process.exit(1);
  });
