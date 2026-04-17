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

export function registerAdminTopicRoutes(app: FastifyInstance): void {
  app.get('/admin/topics', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const topics = await app.repos.curriculum.listTopics();
    const components = await app.repos.curriculum.listComponents();
    const componentTitles = new Map(components.map((c) => [c.code, c.title]));
    return reply.view('admin_topics_list.eta', {
      title: 'Topics',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      topics: topics.map((t) => ({
        ...t,
        component_title: componentTitles.get(t.component_code) ?? null,
      })),
      flash: null,
    });
  });
}
