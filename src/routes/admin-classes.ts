import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ClassAccessError, canManageClasses } from '../services/classes.js';

const CreateClassBody = z.object({
  name: z.string().trim().min(1).max(120),
  academic_year: z.string().trim().min(1).max(20),
  _csrf: z.string().min(1),
});

const EnrolBody = z.object({
  pupil_username: z.string().trim().min(1).max(120),
  _csrf: z.string().min(1),
});

const RemoveEnrolmentBody = z.object({
  _csrf: z.string().min(1),
});

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const EnrolmentParams = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
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

export function registerAdminClassRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/admin/classes', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const classes = await app.services.classes.listClassesFor(actor);
    return reply.view('admin_classes_list.eta', {
      title: 'Classes',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      classes,
      isAdmin: actor.role === 'admin',
      flash: null,
    });
  });

  app.get('/admin/classes/new', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    return reply.view('admin_class_new.eta', {
      title: 'New class',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      flash: null,
      values: { name: '', academic_year: '' },
    });
  });

  app.post('/admin/classes', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const parsed = CreateClassBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).view('admin_class_new.eta', {
        title: 'New class',
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        flash: 'Please fill in the class name and academic year.',
        values: readStringFields(req.body, ['name', 'academic_year']),
      });
    }
    try {
      const cls = await app.services.classes.createClass(actor, {
        name: parsed.data.name,
        academicYear: parsed.data.academic_year,
      });
      return reply.redirect(`/admin/classes/${cls.id}`);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).view('admin_class_new.eta', {
          title: 'New class',
          currentUser: req.currentUser,
          csrfToken: reply.generateCsrf(),
          flash: 'You already have a class with that name for that year.',
          values: { name: parsed.data.name, academic_year: parsed.data.academic_year },
        });
      }
      throw err;
    }
  });

  app.get('/admin/classes/:id', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    try {
      const cls = await app.services.classes.getClassFor(actor, String(params.data.id));
      if (!cls) return reply.code(404).send('Class not found');
      const pupils = await app.services.classes.listPupils(actor, cls.id);
      return reply.view('admin_class_detail.eta', {
        title: `Class · ${cls.name}`,
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        cls,
        pupils,
        flash: readQueryFlash(req),
      });
    } catch (err) {
      if (err instanceof ClassAccessError) return reply.code(403).send('Forbidden');
      throw err;
    }
  });

  app.post('/admin/classes/:id/enrol', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const parsed = EnrolBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.redirect(
        `/admin/classes/${params.data.id}?flash=${encodeURIComponent('Enter a pupil username.')}`,
      );
    }
    try {
      const result = await app.services.classes.enrolPupilByUsername(
        actor,
        String(params.data.id),
        parsed.data.pupil_username,
      );
      const msg =
        result.status === 'added'
          ? `Enrolled ${result.pupilDisplayName}.`
          : `${result.pupilDisplayName} is already enrolled.`;
      return reply.redirect(`/admin/classes/${params.data.id}?flash=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (err instanceof ClassAccessError) {
        if (err.reason === 'pupil_not_found') {
          return reply.redirect(
            `/admin/classes/${params.data.id}?flash=${encodeURIComponent(
              'No active pupil with that username.',
            )}`,
          );
        }
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
  });

  app.post(
    '/admin/classes/:id/enrolments/:userId/remove',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = EnrolmentParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = RemoveEnrolmentBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send('Bad request');
      try {
        const status = await app.services.classes.removePupil(
          actor,
          String(params.data.id),
          String(params.data.userId),
        );
        const msg = status === 'removed' ? 'Pupil removed from class.' : 'Pupil was not enrolled.';
        return reply.redirect(`/admin/classes/${params.data.id}?flash=${encodeURIComponent(msg)}`);
      } catch (err) {
        if (err instanceof ClassAccessError) return reply.code(403).send('Forbidden');
        throw err;
      }
    },
  );
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}

function readStringFields<K extends string>(body: unknown, keys: K[]): Record<K, string> {
  const record = (body ?? {}) as Record<string, unknown>;
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = record[k];
    out[k] = typeof v === 'string' ? v : '';
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
