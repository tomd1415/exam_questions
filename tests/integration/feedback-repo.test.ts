import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackRepo } from '../../src/repos/feedback.js';
import { AuditRepo } from '../../src/repos/audit.js';
import { UserRepo } from '../../src/repos/users.js';
import { AuditService } from '../../src/services/audit.js';
import { FeedbackService, FeedbackError } from '../../src/services/feedback.js';
import { cleanDb, getSharedPool } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

const pool = getSharedPool();
const repo = new FeedbackRepo(pool);
const audit = new AuditService(new AuditRepo(pool));
const users = new UserRepo(pool);
const service = new FeedbackService(repo, audit, users);

beforeEach(async () => {
  await cleanDb();
});

describe('FeedbackRepo', () => {
  it('creates a feedback row with defaults and can read it back', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const row = await repo.create({ userId: pupil.id, comment: 'The timer is too small.' });
    expect(row.comment).toBe('The timer is too small.');
    expect(row.status).toBe('new');
    expect(row.category).toBeNull();
    expect(row.user_id).toBe(pupil.id);

    const fetched = await repo.findById(row.id);
    expect(fetched?.comment).toBe('The timer is too small.');
    expect(fetched?.author_username).toBe(pupil.username);
  });

  it('triage() sets status, category, notes and resolved_at when resolved', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });
    const row = await repo.create({ userId: pupil.id, comment: 'Font is too small.' });

    const updated = await repo.triage(row.id, {
      status: 'resolved',
      category: 'ui',
      triageNotes: 'Larger font shipped in chunk 6.',
      triagedBy: teacher.id,
    });

    expect(updated?.status).toBe('resolved');
    expect(updated?.category).toBe('ui');
    expect(updated?.triage_notes).toBe('Larger font shipped in chunk 6.');
    expect(updated?.triaged_by).toBe(teacher.id);
    expect(updated?.triaged_at).not.toBeNull();
    expect(updated?.resolved_at).not.toBeNull();
  });

  it('triage() leaves resolved_at null when status is triaged', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });
    const row = await repo.create({ userId: pupil.id, comment: 'Hello' });
    const updated = await repo.triage(row.id, {
      status: 'triaged',
      category: 'ux',
      triageNotes: null,
      triagedBy: teacher.id,
    });
    expect(updated?.status).toBe('triaged');
    expect(updated?.resolved_at).toBeNull();
    expect(updated?.triaged_at).not.toBeNull();
  });

  it('listAll orders most recent first and joins author info', async () => {
    const pupilA = await createUser(pool, { role: 'pupil' });
    const pupilB = await createUser(pool, { role: 'pupil' });
    await repo.create({ userId: pupilA.id, comment: 'first' });
    await repo.create({ userId: pupilB.id, comment: 'second' });
    const all = await repo.listAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.comment).toBe('second');
    expect(all[1]!.comment).toBe('first');
    expect(all[0]!.author_display_name).toBe(pupilB.display_name);
  });

  it('listByUser only returns rows for that user', async () => {
    const pupilA = await createUser(pool, { role: 'pupil' });
    const pupilB = await createUser(pool, { role: 'pupil' });
    await repo.create({ userId: pupilA.id, comment: 'mine' });
    await repo.create({ userId: pupilB.id, comment: 'theirs' });
    const mine = await repo.listByUser(pupilA.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.comment).toBe('mine');
  });
});

describe('FeedbackService', () => {
  it('rejects an empty comment', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    await expect(
      service.submit({ id: pupil.id, role: 'pupil' }, { comment: '   ' }),
    ).rejects.toBeInstanceOf(FeedbackError);
  });

  it('rejects a comment longer than 2000 chars', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const tooLong = 'x'.repeat(2001);
    await expect(
      service.submit({ id: pupil.id, role: 'pupil' }, { comment: tooLong }),
    ).rejects.toBeInstanceOf(FeedbackError);
  });

  it('submits, trims whitespace, and records an audit event', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const row = await service.submit(
      { id: pupil.id, role: 'pupil' },
      { comment: '   the marker was slow  ' },
    );
    expect(row.comment).toBe('the marker was slow');

    const { rows } = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM audit_events WHERE event_type = 'feedback.submitted'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      feedback_id: row.id,
      comment_length: 'the marker was slow'.length,
    });
  });

  it('pupil cannot triage; teacher can', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });
    const row = await service.submit({ id: pupil.id, role: 'pupil' }, { comment: 'hi' });

    await expect(
      service.triage({ id: pupil.id, role: 'pupil' }, row.id, {
        status: 'triaged',
        category: null,
        triageNotes: null,
      }),
    ).rejects.toBeInstanceOf(FeedbackError);

    const updated = await service.triage({ id: teacher.id, role: 'teacher' }, row.id, {
      status: 'in_progress',
      category: 'ui',
      triageNotes: 'Looking into it',
    });
    expect(updated.status).toBe('in_progress');
    expect(updated.category).toBe('ui');
  });

  it('rejects invalid status and category values', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });
    const row = await service.submit({ id: pupil.id, role: 'pupil' }, { comment: 'hi' });

    await expect(
      service.triage({ id: teacher.id, role: 'teacher' }, row.id, {
        status: 'bogus',
        category: null,
        triageNotes: null,
      }),
    ).rejects.toBeInstanceOf(FeedbackError);

    await expect(
      service.triage({ id: teacher.id, role: 'teacher' }, row.id, {
        status: 'triaged',
        category: 'bogus',
        triageNotes: null,
      }),
    ).rejects.toBeInstanceOf(FeedbackError);
  });
});

describe('FeedbackService.submitOnBehalf', () => {
  it('teacher can log feedback attributed to the pupil, recording themselves as submitter', async () => {
    const pupil = await createUser(pool, { role: 'pupil' });
    const teacher = await createUser(pool, { role: 'teacher' });

    const row = await service.submitOnBehalf(
      { id: teacher.id, role: 'teacher' },
      { pupilUsername: pupil.username, comment: '  said the timer is hard to see  ' },
    );

    expect(row.user_id).toBe(pupil.id);
    expect(row.submitted_by_user_id).toBe(teacher.id);
    expect(row.comment).toBe('said the timer is hard to see');

    const { rows } = await pool.query<{
      event_type: string;
      actor_user_id: string;
      subject_user_id: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id::text, subject_user_id::text, details
         FROM audit_events
        WHERE event_type = 'feedback.submitted_on_behalf'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(teacher.id);
    expect(rows[0]!.subject_user_id).toBe(pupil.id);
    expect(rows[0]!.details).toMatchObject({
      feedback_id: row.id,
      pupil_user_id: pupil.id,
      pupil_username: pupil.username,
    });
  });

  it('pupil caller is forbidden', async () => {
    const pupilA = await createUser(pool, { role: 'pupil' });
    const pupilB = await createUser(pool, { role: 'pupil' });
    await expect(
      service.submitOnBehalf(
        { id: pupilA.id, role: 'pupil' },
        { pupilUsername: pupilB.username, comment: 'hi' },
      ),
    ).rejects.toBeInstanceOf(FeedbackError);
  });

  it('unknown username raises pupil_not_found', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    await expect(
      service.submitOnBehalf(
        { id: teacher.id, role: 'teacher' },
        { pupilUsername: 'does_not_exist', comment: 'hi' },
      ),
    ).rejects.toMatchObject({ reason: 'pupil_not_found' });
  });

  it('teacher username is not treated as a pupil', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const otherTeacher = await createUser(pool, { role: 'teacher' });
    await expect(
      service.submitOnBehalf(
        { id: teacher.id, role: 'teacher' },
        { pupilUsername: otherTeacher.username, comment: 'hi' },
      ),
    ).rejects.toMatchObject({ reason: 'pupil_not_found' });
  });

  it('inactive pupils are not accepted', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const pupil = await createUser(pool, { role: 'pupil', active: false });
    await expect(
      service.submitOnBehalf(
        { id: teacher.id, role: 'teacher' },
        { pupilUsername: pupil.username, comment: 'hi' },
      ),
    ).rejects.toMatchObject({ reason: 'pupil_not_found' });
  });

  it('rejects empty and overly long comments', async () => {
    const teacher = await createUser(pool, { role: 'teacher' });
    const pupil = await createUser(pool, { role: 'pupil' });

    await expect(
      service.submitOnBehalf(
        { id: teacher.id, role: 'teacher' },
        { pupilUsername: pupil.username, comment: '   ' },
      ),
    ).rejects.toMatchObject({ reason: 'empty_comment' });

    await expect(
      service.submitOnBehalf(
        { id: teacher.id, role: 'teacher' },
        { pupilUsername: pupil.username, comment: 'x'.repeat(2001) },
      ),
    ).rejects.toMatchObject({ reason: 'comment_too_long' });
  });
});
