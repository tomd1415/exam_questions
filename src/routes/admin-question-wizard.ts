import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canManageClasses } from '../services/classes.js';
import {
  DraftAccessError,
  DraftStateError,
  type ActorForDraft,
} from '../services/question_drafts.js';

// The wizard is its own route file (not bolted onto admin-questions.ts) so the
// nine GET / nine POST endpoints, the "My drafts" list, and the publish action
// can grow per-step UX without tangling with the existing single-page admin
// form. The single-page form at /admin/questions/new stays for the Phase-3
// "I just need to fix one field" path; the wizard is the authoring path.

const StepParams = z.object({
  draftId: z.coerce.number().int().positive(),
  n: z.coerce.number().int().min(1).max(9),
});

const DraftIdParams = z.object({
  draftId: z.coerce.number().int().positive(),
});

const CsrfOnly = z.object({ _csrf: z.string().min(1) });

function requireTeacherOrAdmin(req: FastifyRequest, reply: FastifyReply): ActorForDraft | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (!canManageClasses(req.currentUser)) {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: req.currentUser.role };
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}

function handleDraftError(err: unknown, reply: FastifyReply, draftId: string | null): FastifyReply {
  if (err instanceof DraftAccessError) {
    if (err.reason === 'not_found') return reply.code(404).send('Draft not found');
    return reply.code(403).send('Forbidden');
  }
  if (err instanceof DraftStateError) {
    if (err.reason === 'already_published' && draftId) {
      return reply.redirect(
        `/admin/questions/wizard/${draftId}/step/9?flash=${encodeURIComponent(
          'This draft has already been published.',
        )}`,
      );
    }
    if (err.reason === 'incomplete_for_publish' && draftId) {
      return reply.redirect(
        `/admin/questions/wizard/${draftId}/step/9?flash=${encodeURIComponent(
          'Finish every step before publishing.',
        )}`,
      );
    }
    return reply.code(400).send('Bad request');
  }
  throw err;
}

export function registerAdminQuestionWizardRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  // List the actor's drafts. Used as the wizard's landing page; teachers
  // come here from /admin/questions to resume or start a new draft.
  app.get('/admin/questions/wizard', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const drafts = await app.services.questionDrafts.listForActor(actor);
    return reply.view('admin_drafts_list.eta', {
      title: 'My question drafts',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      drafts,
      flash: readQueryFlash(req),
    });
  });

  // Create a new draft and redirect to step 1. POST so the create is not
  // accidentally re-triggered by a back-button or pre-fetch.
  app.post(
    '/admin/questions/wizard/new',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const draftId = await app.services.questionDrafts.create(actor);
      return reply.redirect(`/admin/questions/wizard/${draftId}/step/1`);
    },
  );

  // Render a wizard step. The route doesn't enforce step ≤ current_step + 1
  // (so an author can revisit any step they've already touched), but step 9
  // checks the payload is publish-ready before showing the publish button.
  app.get('/admin/questions/wizard/:draftId/step/:n', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = StepParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const { draftId, n } = params.data;
    const draftIdStr = String(draftId);

    let draft;
    try {
      draft = await app.services.questionDrafts.findForActor(actor, draftIdStr);
    } catch (err) {
      return handleDraftError(err, reply, draftIdStr);
    }

    return reply.view('admin_wizard_step.eta', {
      title: `Step ${n} of 9`,
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      draft,
      step: n,
      flash: readQueryFlash(req),
    });
  });

  // Advance a step. Step-specific parsing/validation will land alongside
  // each step template; for the scaffolding pass we accept just the CSRF
  // token and merge nothing into the payload. That's enough to prove the
  // POST routes round-trip and the audit event fires.
  app.post(
    '/admin/questions/wizard/:draftId/step/:n',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = StepParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const csrf = CsrfOnly.safeParse(req.body);
      if (!csrf.success) return reply.code(400).send('Bad request');
      const { draftId, n } = params.data;
      const draftIdStr = String(draftId);

      try {
        const updated = await app.services.questionDrafts.advance(actor, draftIdStr, n, {});
        const next = Math.min(9, updated.current_step);
        return reply.redirect(`/admin/questions/wizard/${draftIdStr}/step/${next}`);
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }
    },
  );

  // Publish the draft. Only step 9 calls this; the route guards on its own
  // because curl-style direct POSTs from anywhere else would otherwise sneak
  // through.
  app.post(
    '/admin/questions/wizard/:draftId/publish',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = DraftIdParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const csrf = CsrfOnly.safeParse(req.body);
      if (!csrf.success) return reply.code(400).send('Bad request');
      const draftIdStr = String(params.data.draftId);

      try {
        const { questionId } = await app.services.questionDrafts.publish(actor, draftIdStr);
        return reply.redirect(
          `/admin/questions/${questionId}?flash=${encodeURIComponent('Published from wizard.')}`,
        );
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }
    },
  );
}
