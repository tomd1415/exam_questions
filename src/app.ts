import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { UserRepo, type UserRow } from './repos/users.js';
import { SessionRepo } from './repos/sessions.js';
import { AuditRepo } from './repos/audit.js';
import { QuestionRepo } from './repos/questions.js';
import { AttemptRepo } from './repos/attempts.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerQuestionRoutes } from './routes/questions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, 'templates');
const STATIC_DIR = resolve(__dirname, 'static');

declare module 'fastify' {
  interface FastifyInstance {
    services: {
      auth: AuthService;
      audit: AuditService;
    };
    repos: {
      questions: QuestionRepo;
      attempts: AttemptRepo;
    };
  }
  interface FastifyRequest {
    currentUser: UserRow | null;
    sessionId: string | null;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const loggerOptions =
    config.NODE_ENV === 'development'
      ? {
          level: config.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : { level: config.LOG_LEVEL };

  const app: FastifyInstance = Fastify({ logger: loggerOptions });

  await app.register(fastifyCookie, { secret: config.SESSION_SECRET });
  await app.register(fastifyFormbody);
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieOpts: { signed: true },
  });

  const eta = new Eta({ views: TEMPLATES_DIR, cache: config.NODE_ENV === 'production' });
  await app.register(fastifyView, {
    engine: { eta },
    root: TEMPLATES_DIR,
    viewExt: 'eta',
  });

  await app.register(fastifyStatic, {
    root: STATIC_DIR,
    prefix: '/static/',
    decorateReply: false,
  });

  const userRepo = new UserRepo(pool);
  const sessionRepo = new SessionRepo(pool);
  const auditRepo = new AuditRepo(pool);
  const questionRepo = new QuestionRepo(pool);
  const attemptRepo = new AttemptRepo(pool);
  const auditService = new AuditService(auditRepo);
  const authService = new AuthService(userRepo, sessionRepo, auditService);

  app.decorate('services', { auth: authService, audit: auditService });
  app.decorate('repos', { questions: questionRepo, attempts: attemptRepo });
  app.decorateRequest('currentUser', null);
  app.decorateRequest('sessionId', null);

  app.addHook('preHandler', async (req) => {
    const sid = req.cookies['sid'];
    if (!sid) return;
    const unsigned = req.unsignCookie(sid);
    if (!unsigned.valid || unsigned.value === null) return;
    const user = await authService.resolveSession(unsigned.value);
    if (user) {
      req.currentUser = user;
      req.sessionId = unsigned.value;
    }
  });

  app.get('/', (req, reply) => {
    if (req.currentUser) {
      return reply.redirect('/q/1');
    }
    return reply.redirect('/login');
  });

  registerAuthRoutes(app);
  registerQuestionRoutes(app);

  app.get('/healthz', () => ({ ok: true }));

  return app;
}
