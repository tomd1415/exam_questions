import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function registerQuestionRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/q/:id', async (req, reply) => {
    const user = req.currentUser;
    if (!user) return reply.redirect('/login');

    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');

    const question = await app.repos.questions.findById(String(params.data.id));
    if (!question) return reply.code(404).send('Question not found');

    const csrfToken = reply.generateCsrf();
    const savedAttemptId =
      typeof (req.query as { saved?: unknown }).saved === 'string'
        ? (req.query as { saved: string }).saved
        : null;

    return reply.view('question.eta', {
      title: `Question ${question.id}`,
      user,
      question,
      csrfToken,
      savedAttemptId,
    });
  });

  app.post('/q/:id', { preValidation: csrfPreValidation }, async (req, reply) => {
    const user = req.currentUser;
    if (!user) return reply.redirect('/login');

    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');

    const question = await app.repos.questions.findById(String(params.data.id));
    if (!question) return reply.code(404).send('Question not found');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const parts = question.parts.map((p) => ({
      questionPartId: p.id,
      rawAnswer: typeof body[`part_${p.id}`] === 'string' ? (body[`part_${p.id}`] as string) : '',
    }));

    const classId = await app.repos.attempts.findDemoClassId();
    if (!classId) {
      req.log.error('Phase 0 demo class missing — seed migration not applied?');
      return reply.code(500).send('Server misconfigured: demo class missing');
    }

    const saved = await app.repos.attempts.saveSubmission({
      userId: user.id,
      classId,
      questionId: question.id,
      parts,
    });

    await app.services.audit.record(
      { userId: user.id, role: user.role },
      'attempt.submitted',
      { attempt_id: saved.attempt_id, question_id: question.id },
      user.id,
    );

    return reply.redirect(`/q/${question.id}?saved=${saved.attempt_id}`);
  });
}
