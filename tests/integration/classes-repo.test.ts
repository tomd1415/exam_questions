import { describe, it, expect, beforeEach } from 'vitest';
import { ClassRepo } from '../../src/repos/classes.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const classes = new ClassRepo(pool);

beforeEach(async () => {
  await cleanDb();
});

describe('ClassRepo.createClass', () => {
  it('inserts and returns the new row with defaults', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const cls = await classes.createClass({
      name: '10A Computing',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    expect(cls.id).toMatch(/^\d+$/);
    expect(cls.name).toBe('10A Computing');
    expect(cls.teacher_id).toBe(teacher.id);
    expect(cls.academic_year).toBe('2025/26');
    expect(cls.active).toBe(true);
  });

  it('rejects a duplicate (teacher, year, name) tuple', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await classes.createClass({
      name: '10A Computing',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    await expect(
      classes.createClass({
        name: '10A Computing',
        teacherId: teacher.id,
        academicYear: '2025/26',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('ClassRepo.findById / listForTeacher / listAllWithTeacher', () => {
  it('findById round-trips a created class', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const created = await classes.createClass({
      name: 'X',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    const fetched = await classes.findById(created.id);
    expect(fetched?.name).toBe('X');
    expect(fetched?.teacher_id).toBe(teacher.id);
  });

  it('findById returns null for unknown id', async () => {
    expect(await classes.findById('999999')).toBeNull();
  });

  it('listForTeacher returns only that teacher\u2019s classes', async () => {
    const t1 = await createUser(pool, { role: 'teacher' });
    const t2 = await createUser(pool, { role: 'teacher' });
    await classes.createClass({ name: 'A', teacherId: t1.id, academicYear: '2025/26' });
    await classes.createClass({ name: 'B', teacherId: t1.id, academicYear: '2024/25' });
    await classes.createClass({ name: 'C', teacherId: t2.id, academicYear: '2025/26' });

    const got = await classes.listForTeacher(t1.id);
    expect(got.map((c) => c.name).sort()).toEqual(['A', 'B']);
  });

  it('listAllWithTeacher returns every class with teacher fields', async () => {
    const t1 = await createUser(pool, { role: 'teacher', displayName: 'Alice' });
    const t2 = await createUser(pool, { role: 'teacher', displayName: 'Bob' });
    await classes.createClass({ name: 'A', teacherId: t1.id, academicYear: '2025/26' });
    await classes.createClass({ name: 'C', teacherId: t2.id, academicYear: '2025/26' });

    const all = await classes.listAllWithTeacher();
    const testRows = all.filter((r) => r.name === 'A' || r.name === 'C');
    expect(testRows).toHaveLength(2);
    const a = testRows.find((r) => r.name === 'A')!;
    expect(a.teacher_display_name).toBe('Alice');
    expect(a.teacher_username).toBe(t1.username);
  });
});

describe('ClassRepo enrolment lifecycle', () => {
  it('addEnrolment is idempotent and removeEnrolment reports correctly', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const pupil = await createUser(pool, { role: 'pupil' });
    const cls = await classes.createClass({
      name: 'Y',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });

    expect(await classes.addEnrolment(cls.id, pupil.id)).toBe('added');
    expect(await classes.addEnrolment(cls.id, pupil.id)).toBe('already');

    expect(await classes.removeEnrolment(cls.id, pupil.id)).toBe('removed');
    expect(await classes.removeEnrolment(cls.id, pupil.id)).toBe('not_enrolled');
  });

  it('listPupilsInClass returns enrolled pupils ordered by display name', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const cls = await classes.createClass({
      name: 'Y',
      teacherId: teacher.id,
      academicYear: '2025/26',
    });
    const pupilZ = await createUser(pool, { role: 'pupil', displayName: 'Zara' });
    const pupilA = await createUser(pool, { role: 'pupil', displayName: 'Aki' });
    await classes.addEnrolment(cls.id, pupilZ.id);
    await classes.addEnrolment(cls.id, pupilA.id);

    const pupils = await classes.listPupilsInClass(cls.id);
    expect(pupils.map((p) => p.display_name)).toEqual(['Aki', 'Zara']);
    expect(pupils[0]?.user_id).toBe(pupilA.id);
    expect(pupils[0]?.username).toBe(pupilA.username);
  });
});

describe('ClassRepo.findPupilByUsername', () => {
  it('returns active pupils only', async () => {
    const active = await createUser(pool, { role: 'pupil', username: 'pupil_active' });
    const inactive = await createUser(pool, {
      role: 'pupil',
      username: 'pupil_inactive',
      active: false,
    });
    const teacher = await createUser(pool, { role: 'teacher', username: 'teach_one' });

    expect(await classes.findPupilByUsername(active.username)).toMatchObject({ id: active.id });
    expect(await classes.findPupilByUsername(inactive.username)).toBeNull();
    expect(await classes.findPupilByUsername(teacher.username)).toBeNull();
    expect(await classes.findPupilByUsername('does_not_exist')).toBeNull();
  });
});
