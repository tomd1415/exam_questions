import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import type { Pool } from 'pg';
import { config } from './config.js';
import { pool as defaultPool } from './db/pool.js';
import { UserRepo, type UserRow } from './repos/users.js';
import { SessionRepo } from './repos/sessions.js';
import { AuditRepo } from './repos/audit.js';
import { QuestionRepo } from './repos/questions.js';
import { QuestionDraftRepo } from './repos/question_drafts.js';
import { AttemptRepo } from './repos/attempts.js';
import { ClassRepo } from './repos/classes.js';
import { CurriculumRepo } from './repos/curriculum.js';
import { FeedbackRepo } from './repos/feedback.js';
import { PromptVersionRepo } from './repos/prompts.js';
import { LlmCallRepo } from './repos/llm_calls.js';
import { ContentGuardRepo } from './repos/content_guards.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { ClassService } from './services/classes.js';
import { QuestionService } from './services/questions.js';
import { QuestionDraftService } from './services/question_drafts.js';
import { AttemptService } from './services/attempts.js';
import { TeacherMarkingService } from './services/marking/teacher.js';
import { MarkingDispatcher } from './services/marking/dispatch.js';
import { LlmOpenResponseMarker } from './services/marking/llm.js';
import { ModerationService } from './services/marking/moderation.js';
import { LlmClient } from './services/llm/client.js';
import { FeedbackService } from './services/feedback.js';
import { PromptVersionService } from './services/prompts.js';
import { ContentGuardService } from './services/content_guards.js';
import { seedPromptDraftsFromDisk } from './services/prompts_bootstrap.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerQuestionRoutes } from './routes/questions.js';
import { registerAdminClassRoutes } from './routes/admin-classes.js';
import { registerAdminQuestionRoutes } from './routes/admin-questions.js';
import { registerAdminQuestionWizardRoutes } from './routes/admin-question-wizard.js';
import { registerAdminAttemptRoutes } from './routes/admin-attempts.js';
import { registerAdminTopicRoutes } from './routes/admin-topics.js';
import { registerAdminPromptRoutes } from './routes/admin-prompts.js';
import { registerAdminModerationRoutes } from './routes/admin-moderation.js';
import { registerAdminContentGuardRoutes } from './routes/admin-content-guards.js';
import { registerAttemptRoutes } from './routes/attempts.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerApiRoutes } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, 'templates');
const STATIC_DIR = resolve(__dirname, 'static');

function readAppVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readAppVersion();

declare module 'fastify' {
  interface FastifyInstance {
    services: {
      auth: AuthService;
      audit: AuditService;
      classes: ClassService;
      questions: QuestionService;
      questionDrafts: QuestionDraftService;
      attempts: AttemptService;
      teacherMarking: TeacherMarkingService;
      moderation: ModerationService;
      feedback: FeedbackService;
      prompts: PromptVersionService;
      contentGuards: ContentGuardService;
    };
    repos: {
      users: UserRepo;
      questions: QuestionRepo;
      questionDrafts: QuestionDraftRepo;
      attempts: AttemptRepo;
      classes: ClassRepo;
      curriculum: CurriculumRepo;
      feedback: FeedbackRepo;
      prompts: PromptVersionRepo;
      llmCalls: LlmCallRepo;
      contentGuards: ContentGuardRepo;
    };
  }
  interface FastifyRequest {
    currentUser: UserRow | null;
    sessionId: string | null;
  }
  interface FastifyReply {
    locals?: Record<string, unknown>;
  }
}

export interface BuildAppOptions {
  pool?: Pool;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const pool = options.pool ?? defaultPool;
  const loggerEnabled = options.logger ?? true;

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

  const app: FastifyInstance = Fastify({ logger: loggerEnabled ? loggerOptions : false });

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
  const questionDraftRepo = new QuestionDraftRepo(pool);
  const attemptRepo = new AttemptRepo(pool);
  const classRepo = new ClassRepo(pool);
  const curriculumRepo = new CurriculumRepo(pool);
  const feedbackRepo = new FeedbackRepo(pool);
  const promptRepo = new PromptVersionRepo(pool);
  const llmCallRepo = new LlmCallRepo(pool);
  const contentGuardRepo = new ContentGuardRepo(pool);
  const auditService = new AuditService(auditRepo);
  const authService = new AuthService(userRepo, sessionRepo, auditService);
  const classService = new ClassService(classRepo, auditService);
  const questionService = new QuestionService(questionRepo, curriculumRepo, auditService);
  const questionDraftService = new QuestionDraftService(
    questionDraftRepo,
    questionService,
    auditService,
  );
  const teacherMarkingService = new TeacherMarkingService(attemptRepo, auditService);
  const moderationService = new ModerationService(attemptRepo, auditService);
  const feedbackService = new FeedbackService(feedbackRepo, auditService, userRepo);
  const promptService = new PromptVersionService(promptRepo);
  const contentGuardService = new ContentGuardService(contentGuardRepo);
  await seedPromptDraftsFromDisk(promptRepo);
  await promptService.loadActive();
  await contentGuardService.refresh();

  // LLM marker is only built when the kill switch is on AND an API key
  // is configured. The config.ts superRefine enforces that OPENAI_API_KEY
  // is present when LLM_ENABLED=true, so this branch is safe to take.
  // When disabled, the dispatcher runs deterministic-only exactly as in
  // Phase 2.5 — no LLM allocations, no llm_calls rows, no network calls.
  const llmMarker =
    config.LLM_ENABLED && config.OPENAI_API_KEY
      ? new LlmOpenResponseMarker(
          new LlmClient(llmCallRepo, { apiKey: config.OPENAI_API_KEY }),
          promptService,
        )
      : null;
  const markingDispatcher = new MarkingDispatcher({
    llmEnabled: config.LLM_ENABLED,
    llmMarker,
    contentGuards: contentGuardService,
  });
  const attemptService = new AttemptService(
    attemptRepo,
    classRepo,
    auditService,
    userRepo,
    markingDispatcher,
  );

  app.decorate('services', {
    auth: authService,
    audit: auditService,
    classes: classService,
    questions: questionService,
    questionDrafts: questionDraftService,
    attempts: attemptService,
    teacherMarking: teacherMarkingService,
    moderation: moderationService,
    feedback: feedbackService,
    prompts: promptService,
    contentGuards: contentGuardService,
  });
  app.decorate('repos', {
    users: userRepo,
    questions: questionRepo,
    questionDrafts: questionDraftRepo,
    attempts: attemptRepo,
    classes: classRepo,
    curriculum: curriculumRepo,
    feedback: feedbackRepo,
    prompts: promptRepo,
    llmCalls: llmCallRepo,
    contentGuards: contentGuardRepo,
  });
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

  app.addHook('preHandler', async (req, reply) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    reply.locals = {
      ...(reply.locals ?? {}),
      currentUser: req.currentUser,
      currentPath: path,
      appVersion: APP_VERSION,
    };
  });

  app.get('/', async (req, reply) => {
    const user = req.currentUser;
    if (!user) return reply.redirect('/login');
    if (user.role === 'pupil') {
      const actor = { id: user.id, role: 'pupil' as const };
      const [attempts, topics] = await Promise.all([
        app.services.attempts.listAttemptsForPupil(actor),
        app.services.attempts.listTopicsForPupil(actor),
      ]);
      const inProgress = attempts.filter((a) => a.submitted_at === null);
      const awaitingMarking = attempts.filter(
        (a) => a.submitted_at !== null && a.pending_parts > 0,
      );
      const recentlyReviewed = attempts
        .filter((a) => a.submitted_at !== null && a.pending_parts === 0)
        .slice(0, 5);
      return reply.view('pupil_home.eta', {
        title: 'Home',
        currentUser: user,
        csrfToken: reply.generateCsrf(),
        inProgress,
        awaitingMarking,
        recentlyReviewed,
        topics,
      });
    }
    // teacher or admin: teacher home dashboard
    const actor = { id: user.id, role: user.role };
    const [markingQueue, classes, pendingQuestions] = await Promise.all([
      app.services.attempts.listMarkingQueueForTeacher(actor),
      app.services.classes.listClassesFor(actor),
      app.repos.questions.listQuestions({ approvalStatus: 'pending_review' }),
    ]);
    return reply.view('teacher_home.eta', {
      title: 'Home',
      currentUser: user,
      csrfToken: reply.generateCsrf(),
      markingQueue: markingQueue.slice(0, 5),
      markingQueueTotal: markingQueue.length,
      classes,
      pendingQuestions: pendingQuestions.slice(0, 5),
      pendingQuestionsTotal: pendingQuestions.length,
    });
  });

  registerAuthRoutes(app);
  registerQuestionRoutes(app);
  registerAttemptRoutes(app);
  registerAdminClassRoutes(app);
  registerAdminAttemptRoutes(app);
  registerAdminQuestionRoutes(app);
  registerAdminQuestionWizardRoutes(app);
  registerAdminTopicRoutes(app);
  registerAdminPromptRoutes(app);
  registerAdminModerationRoutes(app);
  registerAdminContentGuardRoutes(app);
  registerFeedbackRoutes(app);
  registerApiRoutes(app);

  app.get('/healthz', () => ({ ok: true }));

  return app;
}
