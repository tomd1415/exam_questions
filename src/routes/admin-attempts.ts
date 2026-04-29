import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AttemptAccessError } from '../services/attempts.js';
import { TeacherMarkingError } from '../services/marking/teacher.js';
import { canManageClasses, ClassAccessError } from '../services/classes.js';
import { buildPupilAnswerViewMap } from '../lib/pupil-answer-view.js';

const ClassParams = z.object({ id: z.coerce.number().int().positive() });
const AttemptParams = z.object({ id: z.coerce.number().int().positive() });
const MarkParams = z.object({
  id: z.coerce.number().int().positive(),
  partId: z.coerce.number().int().positive(),
});

// Reason is optional at the route layer (closes bug_notes.md #4 —
// confirming a mark with no change should not require typing a
// rationale). The service layer still requires a reason on the
// override branch where the marks are actually changing.
const MarkBody = z.object({
  marks_awarded: z.coerce.number().int().min(0).max(100),
  reason: z.string().trim().max(500).default(''),
  _csrf: z.string().min(1),
});

function requireTeacherOrAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'teacher' | 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (!canManageClasses(req.currentUser)) {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: req.currentUser.role as 'teacher' | 'admin' };
}

export function registerAdminAttemptRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/admin/attempts', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const queue = await app.services.attempts.listMarkingQueueForTeacher(actor);
    return reply.view('admin_attempts_queue.eta', {
      title: 'Marking queue',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      queue,
      flash: readQueryFlash(req),
    });
  });

  app.get('/admin/users', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    if (actor.role !== 'admin') return reply.code(403).send('Forbidden');
    return reply.view('admin_stub.eta', {
      title: 'Users',
      heading: 'Users',
      message: 'User administration arrives in Chunk 8. This page is a placeholder.',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
    });
  });

  app.get('/admin/audit', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    if (actor.role !== 'admin') return reply.code(403).send('Forbidden');
    return reply.view('admin_stub.eta', {
      title: 'Audit log',
      heading: 'Audit log',
      message:
        'A searchable audit log lands in Chunk 8. For now, events are written to the database.',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
    });
  });

  app.get('/admin/classes/:id/attempts', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = ClassParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    try {
      const cls = await app.services.classes.getClassFor(actor, String(params.data.id));
      if (!cls) return reply.code(404).send('Class not found');
      const attempts = await app.services.attempts.listSubmittedAttemptsForClass(
        actor,
        String(params.data.id),
      );
      return reply.view('admin_attempts_list.eta', {
        title: `Submissions · ${cls.name}`,
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        cls,
        attempts,
        flash: readQueryFlash(req),
      });
    } catch (err) {
      if (err instanceof AttemptAccessError || err instanceof ClassAccessError) {
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });

  app.get('/admin/attempts/:id', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = AttemptParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    try {
      const bundle = await app.services.attempts.getAttemptForActor(actor, String(params.data.id));
      if (bundle.attempt.submitted_at === null) {
        return reply.code(409).send('Attempt not submitted yet');
      }
      // Chunk 3i follow-up: decoded pupil-answer view per attempt_part
      // so the marking template can render matching / cloze / trace /
      // matrix answers human-readably and image widgets as <img>.
      // Passed as data (Map) rather than a function through the view
      // context, so a missing wiring fails loud in TS rather than
      // 500ing the render at runtime.
      const answerViewByPart = buildPupilAnswerViewMap(bundle.partsByQuestion.values());
      // bug_notes.md #5: prior teacher_overrides reasons for the same
      // question_part — surfaced as a <datalist> on each form so the
      // marker can pick a previously-used phrase instead of retyping.
      const allPartIds: string[] = [];
      for (const list of bundle.partsByQuestion.values()) {
        for (const part of list) allPartIds.push(part.id);
      }
      const priorReasonsByPart = await app.repos.attempts.listPriorTeacherReasons(allPartIds);
      return reply.view('admin_attempt_detail.eta', {
        title: `Mark · Attempt ${bundle.attempt.id}`,
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        bundle,
        flash: readQueryFlash(req),
        answerViewByPart,
        priorReasonsByPart,
      });
    } catch (err) {
      if (err instanceof AttemptAccessError) {
        if (err.reason === 'not_found') return reply.code(404).send('Not found');
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });

  app.post(
    '/admin/attempts/:id/parts/:partId/mark',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = MarkParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      // Closes bug_notes.md #2 (29 Apr 2026): every save-mark redirect
      // anchors back to `#part-<partId>` so the browser restores the
      // teacher's scroll position instead of jumping to the top.
      const partAnchor = `#part-${params.data.partId}`;
      const parsed = MarkBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.redirect(
          `/admin/attempts/${params.data.id}?flash=${encodeURIComponent(
            'Enter a whole-number mark and a reason (up to 500 characters).',
          )}${partAnchor}`,
        );
      }
      try {
        const result = await app.services.teacherMarking.setTeacherMark(
          actor,
          String(params.data.partId),
          parsed.data.marks_awarded,
          parsed.data.reason,
        );
        const flash =
          result.kind === 'confirmed' ? 'Mark confirmed (unchanged).' : 'Mark overridden.';
        return reply.redirect(
          `/admin/attempts/${params.data.id}?flash=${encodeURIComponent(flash)}${partAnchor}`,
        );
      } catch (err) {
        if (err instanceof TeacherMarkingError) {
          if (err.reason === 'not_found') return reply.code(404).send('Not found');
          if (err.reason === 'not_owner' || err.reason === 'self_marking') {
            return reply.code(403).send('Forbidden');
          }
          const message =
            err.reason === 'invalid_marks'
              ? 'Mark is outside the allowed range for that part.'
              : err.reason === 'invalid_reason'
                ? 'A short reason is required.'
                : err.reason === 'not_yet_submitted'
                  ? 'That attempt has not been submitted yet.'
                  : 'Could not save the mark.';
          return reply.redirect(
            `/admin/attempts/${params.data.id}?flash=${encodeURIComponent(message)}${partAnchor}`,
          );
        }
        throw err;
      }
    },
  );
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}
