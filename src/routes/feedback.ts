import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FeedbackError } from '../services/feedback.js';
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../repos/feedback.js';

const SubmitBody = z.object({
  comment: z.string(),
  _csrf: z.string().min(1),
});

const OfflineBody = z.object({
  pupil_username: z.string(),
  comment: z.string(),
  _csrf: z.string().min(1),
});

const TriageParams = z.object({
  id: z.coerce.number().int().positive(),
});

const TriageBody = z.object({
  status: z.string(),
  category: z.string().optional(),
  triage_notes: z.string().optional(),
  _csrf: z.string().min(1),
});

function requireLoggedIn(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'pupil' | 'teacher' | 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  return { id: req.currentUser.id, role: req.currentUser.role };
}

function requireTeacherOrAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'teacher' | 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (req.currentUser.role !== 'teacher' && req.currentUser.role !== 'admin') {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: req.currentUser.role };
}

export function registerFeedbackRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/feedback', async (req, reply) => {
    const actor = requireLoggedIn(req, reply);
    if (!actor) return reply;

    const mine = await app.services.feedback.listMine(actor);
    return reply.view('feedback_new.eta', {
      title: 'Send feedback',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      flash: null,
      flashKind: null,
      mine,
    });
  });

  app.post('/feedback', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireLoggedIn(req, reply);
    if (!actor) return reply;

    const parsed = SubmitBody.safeParse(req.body);
    if (!parsed.success) {
      const mine = await app.services.feedback.listMine(actor);
      return reply.code(400).view('feedback_new.eta', {
        title: 'Send feedback',
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        flash: 'Please add a comment before submitting.',
        flashKind: 'error',
        mine,
      });
    }

    try {
      await app.services.feedback.submit(actor, { comment: parsed.data.comment });
    } catch (err) {
      if (err instanceof FeedbackError) {
        const mine = await app.services.feedback.listMine(actor);
        const msg =
          err.reason === 'empty_comment'
            ? 'Please add a comment before submitting.'
            : err.reason === 'comment_too_long'
              ? 'That comment is a bit long — please keep it under 2000 characters.'
              : 'Could not save feedback.';
        return reply.code(400).view('feedback_new.eta', {
          title: 'Send feedback',
          currentUser: req.currentUser,
          csrfToken: reply.generateCsrf(),
          flash: msg,
          flashKind: 'error',
          mine,
        });
      }
      throw err;
    }

    const mine = await app.services.feedback.listMine(actor);
    return reply.view('feedback_new.eta', {
      title: 'Send feedback',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      flash: 'Thank you — your feedback has been sent.',
      flashKind: 'ok',
      mine,
    });
  });

  app.get('/admin/feedback/new', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;

    return reply.view('admin_feedback_new.eta', {
      title: 'Log offline feedback',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      flash: null,
      flashKind: null,
      pupilUsername: '',
      comment: '',
    });
  });

  app.post('/admin/feedback/new', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;

    const parsed = OfflineBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).view('admin_feedback_new.eta', {
        title: 'Log offline feedback',
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        flash: 'Please fill in both the pupil username and the comment.',
        flashKind: 'error',
        pupilUsername: '',
        comment: '',
      });
    }

    try {
      await app.services.feedback.submitOnBehalf(actor, {
        pupilUsername: parsed.data.pupil_username,
        comment: parsed.data.comment,
      });
    } catch (err) {
      if (err instanceof FeedbackError) {
        const msg =
          err.reason === 'empty_comment'
            ? 'Please add a comment before submitting.'
            : err.reason === 'comment_too_long'
              ? 'That comment is a bit long — please keep it under 2000 characters.'
              : err.reason === 'pupil_not_found'
                ? 'No active pupil with that username.'
                : err.reason === 'pupil_is_self'
                  ? 'You can submit your own feedback through /feedback.'
                  : 'Could not log feedback.';
        return reply.code(400).view('admin_feedback_new.eta', {
          title: 'Log offline feedback',
          currentUser: req.currentUser,
          csrfToken: reply.generateCsrf(),
          flash: msg,
          flashKind: 'error',
          pupilUsername: parsed.data.pupil_username,
          comment: parsed.data.comment,
        });
      }
      throw err;
    }

    return reply.redirect('/admin/feedback');
  });

  app.get('/admin/feedback', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;

    const items = await app.services.feedback.listAll(actor);
    return reply.view('admin_feedback_list.eta', {
      title: 'Feedback',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      items,
      statuses: FEEDBACK_STATUSES,
      categories: FEEDBACK_CATEGORIES,
      flash: null,
      flashKind: null,
    });
  });

  app.post(
    '/admin/feedback/:id/triage',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;

      const params = TriageParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');

      const body = TriageBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send('Invalid form');

      try {
        await app.services.feedback.triage(actor, String(params.data.id), {
          status: body.data.status,
          category: body.data.category ?? null,
          triageNotes: body.data.triage_notes ?? null,
        });
      } catch (err) {
        if (err instanceof FeedbackError) {
          if (err.reason === 'not_found') return reply.code(404).send('Not found');
          if (err.reason === 'forbidden') return reply.code(403).send('Forbidden');
          return reply.code(400).send(`Invalid triage: ${err.reason}`);
        }
        throw err;
      }

      return reply.redirect('/admin/feedback');
    },
  );
}
