import { describe, it, expect, beforeEach } from 'vitest';
import { AttemptRepo } from '../../src/repos/attempts.js';
import { ClassRepo } from '../../src/repos/classes.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { UserRepo } from '../../src/repos/users.js';
import { AuditService } from '../../src/services/audit.js';
import { AttemptService } from '../../src/services/attempts.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const userRepo = new UserRepo(pool);
const auditService = new AuditService(new AuditRepo(pool));
const service = new AttemptService(
  new AttemptRepo(pool),
  new ClassRepo(pool),
  auditService,
  userRepo,
);

beforeEach(async () => {
  await cleanDb();
});

describe('font preference repo + service', () => {
  it('defaults new users to "system"', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const row = await userRepo.findById(pupil.id);
    expect(row?.font_preference).toBe('system');
  });

  it('round-trips both valid values and writes an audit event', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await service.setFontPreferenceForUser({ id: pupil.id, role: 'pupil' }, 'dyslexic');
    expect((await userRepo.findById(pupil.id))?.font_preference).toBe('dyslexic');
    await service.setFontPreferenceForUser({ id: pupil.id, role: 'pupil' }, 'system');
    expect((await userRepo.findById(pupil.id))?.font_preference).toBe('system');

    const audit = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM audit_events WHERE actor_user_id = $1::bigint
         AND event_type = 'user.font_preference.set' ORDER BY id ASC`,
      [pupil.id],
    );
    expect(audit.rows.map((r) => r.details['font'])).toEqual(['dyslexic', 'system']);
  });

  it('DB check rejects values outside the allowed set', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await expect(
      pool.query(`UPDATE users SET font_preference = 'comic-sans' WHERE id = $1::bigint`, [
        pupil.id,
      ]),
    ).rejects.toThrow(/font_preference/);
  });
});
