import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AttemptAccessError } from '../services/attempts.js';
import { REVEAL_MODES } from '../repos/users.js';

const StartBody = z.object({ _csrf: z.string().min(1) });

const SaveBody = z.object({ _csrf: z.string().min(1) }).passthrough();

const AutosaveBody = z.object({ raw_answer: z.string().max(5000) });

const SubmitBody = z.object({
  _csrf: z.string().min(1),
  elapsed_seconds: z.string().trim().optional(),
});

const SelfMarkBody = z.object({
  _csrf: z.string().min(1),
  marks: z.string().trim().optional(),
});

const RevealModeBody = z.object({
  _csrf: z.string().min(1),
  mode: z.enum(REVEAL_MODES as readonly ['per_question', 'whole_attempt']),
});

const TopicParams = z.object({
  code: z.string().trim().min(1).max(60),
});
const AttemptParams = z.object({
  id: z.coerce.number().int().positive(),
});
const AttemptQuestionParams = z.object({
  id: z.coerce.number().int().positive(),
  qid: z.coerce.number().int().positive(),
});
const AttemptPartParams = z.object({
  id: z.coerce.number().int().positive(),
  pid: z.coerce.number().int().positive(),
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
      revealMode: req.currentUser?.reveal_mode ?? 'per_question',
      flash: readQueryFlash(req),
    });
  });

  app.get('/attempts', async (req, reply) => {
    const actor = requirePupil(req, reply);
    if (!actor) return reply;
    const attempts = await app.services.attempts.listAttemptsForPupil(actor);
    return reply.view('attempts_list.eta', {
      title: 'My attempts',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      attempts,
      flash: readQueryFlash(req),
    });
  });

  app.post(
    '/me/preferences/reveal-mode',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requirePupil(req, reply);
      if (!actor) return reply;
      const parsed = RevealModeBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send('Bad request');
      await app.services.attempts.setRevealModeForUser(actor, parsed.data.mode);
      const label =
        parsed.data.mode === 'per_question'
          ? 'one question at a time'
          : 'the whole attempt at once';
      return reply.redirect(
        `/topics?flash=${encodeURIComponent(`Preference saved: you will submit ${label}.`)}`,
      );
    },
  );

  app.post('/topics/:code/start', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requirePupil(req, reply);
    if (!actor) return reply;
    const params = TopicParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send('Bad request');
    try {
      const mode = req.currentUser?.reveal_mode ?? 'per_question';
      const result = await app.services.attempts.startTopicSet(actor, params.data.code, mode);
      if (result.resumed) {
        return reply.redirect(
          `/attempts/${result.attemptId}?flash=${encodeURIComponent('Resuming your in-progress attempt. Submit it before starting a new one.')}`,
        );
      }
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

      let currentQuestionIndex = 0;
      if (bundle.attempt.reveal_mode === 'per_question' && bundle.attempt.submitted_at === null) {
        const qParam = (req.query as { q?: unknown }).q;
        const qId = typeof qParam === 'string' ? qParam : null;
        if (qId) {
          const idx = bundle.questions.findIndex((q) => q.id === qId);
          if (idx >= 0) currentQuestionIndex = idx;
        } else {
          const firstUnsubmitted = bundle.questions.findIndex((q) => q.submitted_at === null);
          currentQuestionIndex =
            firstUnsubmitted >= 0 ? firstUnsubmitted : Math.max(0, bundle.questions.length - 1);
        }
      }

      return reply.view(view, {
        title:
          bundle.attempt.submitted_at === null
            ? `Attempt ${bundle.attempt.id}`
            : `Review · Attempt ${bundle.attempt.id}`,
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        bundle,
        currentQuestionIndex,
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
    const elapsed = parseElapsedSeconds(parsed.data.elapsed_seconds);
    try {
      if (answers.length > 0) {
        await app.services.attempts.saveAnswer(actor, String(params.data.id), answers);
      }
      await app.services.attempts.submitAttempt(actor, String(params.data.id), elapsed);
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

  app.post(
    '/attempts/:id/questions/:qid/submit',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requirePupil(req, reply);
      if (!actor) return reply;
      const params = AttemptQuestionParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = SubmitBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send('Bad request');

      const fullBody = (req.body ?? {}) as Record<string, unknown>;
      const answers = readAnswerFields(fullBody);
      const elapsed = parseElapsedSeconds(parsed.data.elapsed_seconds);
      const attemptIdStr = String(params.data.id);
      const qidStr = String(params.data.qid);
      try {
        if (answers.length > 0) {
          await app.services.attempts.saveAnswer(actor, attemptIdStr, answers);
        }
        const result = await app.services.attempts.submitQuestion(
          actor,
          attemptIdStr,
          qidStr,
          elapsed,
        );
        const msg = result.attemptFullySubmitted
          ? 'All questions submitted.'
          : `Question submitted. ${result.pendingParts > 0 ? 'Some parts are waiting for teacher marking.' : ''}`.trim();
        if (result.attemptFullySubmitted) {
          return reply.redirect(`/attempts/${params.data.id}?flash=${encodeURIComponent(msg)}`);
        }
        return reply.redirect(
          `/attempts/${params.data.id}?q=${params.data.qid}&flash=${encodeURIComponent(msg)}`,
        );
      } catch (err) {
        if (err instanceof AttemptAccessError) {
          if (err.reason === 'not_found') return reply.code(404).send('Not found');
          if (err.reason === 'already_submitted' || err.reason === 'question_already_submitted') {
            return reply.redirect(`/attempts/${params.data.id}`);
          }
          return reply.code(403).send('Forbidden');
        }
        throw err;
      }
    },
  );

  app.post(
    '/attempts/:id/parts/:pid/autosave',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requirePupil(req, reply);
      if (!actor) return reply;
      const params = AttemptPartParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ ok: false, error: 'not_found' });
      const parsed = AutosaveBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'bad_request' });
      try {
        const { savedAt } = await app.services.attempts.savePartOne(
          actor,
          String(params.data.pid),
          parsed.data.raw_answer,
        );
        return reply.send({ ok: true, saved_at: savedAt.toISOString() });
      } catch (err) {
        if (err instanceof AttemptAccessError) {
          if (err.reason === 'not_found') {
            return reply.code(404).send({ ok: false, error: 'not_found' });
          }
          if (err.reason === 'already_submitted') {
            return reply.code(409).send({ ok: false, error: 'already_submitted' });
          }
          return reply.code(403).send({ ok: false, error: err.reason });
        }
        throw err;
      }
    },
  );

  app.post(
    '/attempts/:id/parts/:pid/self-mark',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requirePupil(req, reply);
      if (!actor) return reply;
      const params = AttemptPartParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = SelfMarkBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send('Bad request');

      const raw = parsed.data.marks?.trim() ?? '';
      let marks: number | null = null;
      if (raw.length > 0) {
        if (!/^\d+$/.test(raw)) return reply.code(400).send('Bad request');
        marks = Number(raw);
      }
      try {
        await app.services.attempts.recordPupilSelfMark(
          actor,
          String(params.data.id),
          String(params.data.pid),
          marks,
        );
        return reply.redirect(
          `/attempts/${params.data.id}?flash=${encodeURIComponent('Self-estimate saved.')}#p-${params.data.pid}`,
        );
      } catch (err) {
        if (err instanceof AttemptAccessError) {
          if (err.reason === 'not_found') return reply.code(404).send('Not found');
          if (err.reason === 'invalid_self_marks') {
            return reply.redirect(
              `/attempts/${params.data.id}?flash=${encodeURIComponent('Self-estimate must be between 0 and the part max.')}#p-${params.data.pid}`,
            );
          }
          if (err.reason === 'not_submitted_yet') {
            return reply.redirect(
              `/attempts/${params.data.id}?flash=${encodeURIComponent('Submit the question first, then record your self-estimate.')}`,
            );
          }
          return reply.code(403).send('Forbidden');
        }
        throw err;
      }
    },
  );
}

function readAnswerFields(
  body: Record<string, unknown>,
): { attemptPartId: string; rawAnswer: string }[] {
  const out: { attemptPartId: string; rawAnswer: string }[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('part_')) continue;
    const id = key.slice('part_'.length);
    if (!/^\d+$/.test(id)) continue;
    let raw: string;
    if (typeof value === 'string') {
      raw = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      raw = value.join('\n');
    } else {
      continue;
    }
    out.push({ attemptPartId: id, rawAnswer: raw });
  }
  return out;
}

function parseElapsedSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}
