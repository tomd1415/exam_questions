import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canManageClasses } from '../services/classes.js';

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

export function registerAdminPromptRoutes(app: FastifyInstance): void {
  app.get('/admin/prompts/versions', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const versions = await app.services.prompts.listAll();
    return reply.view('admin_prompts_versions.eta', {
      title: 'Prompt versions',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      versions: versions.map((v) => ({
        id: v.id,
        name: v.name,
        version: v.version,
        model_id: v.model_id,
        status: v.status,
        created_at: v.created_at,
        system_prompt_preview: v.system_prompt.slice(0, 200),
        system_prompt_length: v.system_prompt.length,
      })),
    });
  });
}
