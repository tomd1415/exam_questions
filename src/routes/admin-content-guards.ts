import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTENT_GUARD_KINDS, type ContentGuardKind } from '../repos/content_guards.js';

// Admin-only CRUD for the safety-gate's runtime pattern lists
// (chunk 3d). The seeded baseline in src/lib/content-guards.ts is
// always active and cannot be turned off here — this page is for the
// admin's extension entries.

const NewPatternBody = z.object({
  kind: z.enum(['safeguarding', 'prompt_injection']),
  pattern: z.string().trim().min(2).max(200),
  note: z.string().trim().max(500).optional().default(''),
  _csrf: z.string().min(1),
});

const ToggleBody = z.object({
  active: z.union([z.literal('true'), z.literal('false')]),
  _csrf: z.string().min(1),
});

const PatternParams = z.object({ id: z.coerce.number().int().positive() });

function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): { id: string; role: 'admin' } | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (req.currentUser.role !== 'admin') {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: 'admin' };
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}

export function registerAdminContentGuardRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/admin/content-guards', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return reply;
    const all = await app.services.contentGuards.listAll();
    const grouped: Record<ContentGuardKind, typeof all> = {
      safeguarding: [],
      prompt_injection: [],
    };
    for (const row of all) grouped[row.kind].push(row);
    return reply.view('admin_content_guards.eta', {
      title: 'Content guards',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      kinds: CONTENT_GUARD_KINDS,
      grouped,
      flash: readQueryFlash(req),
    });
  });

  app.post('/admin/content-guards', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return reply;
    const parsed = NewPatternBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.redirect(
        `/admin/content-guards?flash=${encodeURIComponent(
          'Pattern must be between 2 and 200 characters.',
        )}`,
      );
    }
    await app.services.contentGuards.add({
      kind: parsed.data.kind,
      pattern: parsed.data.pattern,
      note: parsed.data.note.length > 0 ? parsed.data.note : null,
      createdBy: actor.id,
    });
    return reply.redirect(`/admin/content-guards?flash=${encodeURIComponent('Pattern added.')}`);
  });

  app.post(
    '/admin/content-guards/:id/toggle',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireAdmin(req, reply);
      if (!actor) return reply;
      const params = PatternParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = ToggleBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send('Bad request');
      const next = parsed.data.active === 'true';
      const row = await app.services.contentGuards.setActive(String(params.data.id), next);
      if (!row) return reply.code(404).send('Not found');
      return reply.redirect(
        `/admin/content-guards?flash=${encodeURIComponent(
          next ? 'Pattern re-enabled.' : 'Pattern disabled.',
        )}`,
      );
    },
  );
}
