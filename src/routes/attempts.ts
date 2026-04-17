import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AttemptAccessError } from '../services/attempts.js';

const StartBody = z.object({ _csrf: z.string().min(1) });

const SaveBody = z.object({ _csrf: z.string().min(1) }).passthrough();

const SubmitBody = z.object({ _csrf: z.string().min(1) });

const TopicParams = z.object({
  code: z.string().trim().min(1).max(60),
});
const AttemptParams = z.object({
  id: z.coerce.number().int().positive(),
});

function requirePupil(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'pupil' | 'teacher' | 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (req.currentUser.role !== 'pupil') {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: 'pupil' };
}

function requireAnyActor(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'pupil' | 'teacher' | 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  return {
    id: req.currentUser.id,
    role: req.currentUser.role as 'pupil' | 'teacher' | 'admin',
  };
}

export function registerAttemptRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/topics', async (req, reply) => {
    const actor = requirePupil(req, reply);
    if (!actor) return reply;
    const topics = await app.services.attempts.listTopicsForPupil(actor);
    return reply.view('topics_list.eta', {
      title: 'Revision topics',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      topics,
      flash: readQueryFlash(req),
    });
  });

  app.post('/topics/:code/start', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requirePupil(req, reply);
    if (!actor) return reply;
    const params = TopicParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send('Bad request');
    try {
      const result = await app.services.attempts.startTopicSet(actor, params.data.code);
      return reply.redirect(`/attempts/${result.attemptId}`);
    } catch (err) {
      if (err instanceof AttemptAccessError) {
        if (err.reason === 'not_enrolled') {
          return reply.redirect(
            `/topics?flash=${encodeURIComponent('You are not enrolled in a class for that topic.')}`,
          );
        }
        if (err.reason === 'no_questions') {
          return reply.redirect(
            `/topics?flash=${encodeURIComponent('No approved questions available for that topic yet.')}`,
          );
        }
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });

  app.get('/attempts/:id', async (req, reply) => {
    const actor = requireAnyActor(req, reply);
    if (!actor) return reply;
    const params = AttemptParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    try {
      const bundle = await app.services.attempts.getAttemptForActor(actor, String(params.data.id));
      const view = bundle.attempt.submitted_at === null ? 'attempt_edit.eta' : 'attempt_review.eta';
      return reply.view(view, {
        title:
          bundle.attempt.submitted_at === null
            ? `Attempt ${bundle.attempt.id}`
            : `Review · Attempt ${bundle.attempt.id}`,
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        bundle,
        flash: readQueryFlash(req),
      });
    } catch (err) {
      if (err instanceof AttemptAccessError) {
        if (err.reason === 'not_found') return reply.code(404).send('Not found');
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });

  app.post('/attempts/:id/save', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requirePupil(req, reply);
    if (!actor) return reply;
    const params = AttemptParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send('Bad request');

    const answers = readAnswerFields(parsed.data);
    try {
      const result = await app.services.attempts.saveAnswer(actor, String(params.data.id), answers);
      const msg = `Saved ${result.saved} answer${result.saved === 1 ? '' : 's'}.`;
      return reply.redirect(`/attempts/${params.data.id}?flash=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (err instanceof AttemptAccessError) {
        if (err.reason === 'already_submitted') {
          return reply.redirect(
            `/attempts/${params.data.id}?flash=${encodeURIComponent('Attempt already submitted.')}`,
          );
        }
        if (err.reason === 'not_found') return reply.code(404).send('Not found');
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });

  app.post('/attempts/:id/submit', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requirePupil(req, reply);
    if (!actor) return reply;
    const params = AttemptParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const parsed = SubmitBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send('Bad request');

    const fullBody = (req.body ?? {}) as Record<string, unknown>;
    const answers = readAnswerFields(fullBody);
    try {
      if (answers.length > 0) {
        await app.services.attempts.saveAnswer(actor, String(params.data.id), answers);
      }
      await app.services.attempts.submitAttempt(actor, String(params.data.id));
      return reply.redirect(`/attempts/${params.data.id}`);
    } catch (err) {
      if (err instanceof AttemptAccessError) {
        if (err.reason === 'already_submitted') {
          return reply.redirect(`/attempts/${params.data.id}`);
        }
        if (err.reason === 'not_found') return reply.code(404).send('Not found');
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });
}

function readAnswerFields(
  body: Record<string, unknown>,
): { attemptPartId: string; rawAnswer: string }[] {
  const out: { attemptPartId: string; rawAnswer: string }[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('part_')) continue;
    if (typeof value !== 'string') continue;
    const id = key.slice('part_'.length);
    if (!/^\d+$/.test(id)) continue;
    out.push({ attemptPartId: id, rawAnswer: value });
  }
  return out;
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}
