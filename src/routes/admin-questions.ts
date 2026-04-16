import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canManageClasses } from '../services/classes.js';
import type { ApprovalStatus, ListQuestionsFilters } from '../repos/questions.js';

const APPROVAL_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'archived',
] as const satisfies readonly ApprovalStatus[];

const ListQuery = z.object({
  topic: z.string().trim().min(1).max(20).optional(),
  approval_status: z.enum(APPROVAL_STATUSES).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const IdParams = z.object({ id: z.coerce.number().int().positive() });

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

export function registerAdminQuestionRoutes(app: FastifyInstance): void {
  app.get('/admin/questions', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;

    const parsed = ListQuery.safeParse(req.query);
    const filters: ListQuestionsFilters = {};
    const selected = { topic: '', approval_status: '', active: '' };
    if (parsed.success) {
      if (parsed.data.topic !== undefined) {
        filters.topic = parsed.data.topic;
        selected.topic = parsed.data.topic;
      }
      if (parsed.data.approval_status !== undefined) {
        filters.approvalStatus = parsed.data.approval_status;
        selected.approval_status = parsed.data.approval_status;
      }
      if (parsed.data.active !== undefined) {
        filters.active = parsed.data.active === 'true';
        selected.active = parsed.data.active;
      }
    }

    const [questions, topics] = await Promise.all([
      app.repos.questions.listQuestions(filters),
      app.repos.curriculum.listTopics(),
    ]);

    return reply.view('admin_questions_list.eta', {
      title: 'Questions',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      questions,
      topics,
      selected,
      approvalStatuses: APPROVAL_STATUSES,
    });
  });

  app.get('/admin/questions/:id', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');

    const data = await app.repos.questions.getQuestionWithPartsAndMarkPoints(
      String(params.data.id),
    );
    if (!data) return reply.code(404).send('Question not found');

    return reply.view('admin_question_detail.eta', {
      title: `Question · ${data.question.id}`,
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      detail: {
        question: data.question,
        parts: data.parts.map((p) => ({
          ...p,
          markPoints: data.markPointsByPart.get(p.id) ?? [],
          misconceptions: data.misconceptionsByPart.get(p.id) ?? [],
        })),
        topicMisconceptions: data.topicMisconceptions,
      },
    });
  });
}
