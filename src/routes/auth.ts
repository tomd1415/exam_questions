import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashIp } from '../services/auth.js';
import { config } from '../config.js';

const LoginBody = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(256),
  _csrf: z.string().min(1),
});

const COOKIE_NAME = 'sid';
const COOKIE_BASE_OPTS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/',
  secure: config.NODE_ENV === 'production',
  signed: true,
};

export function registerAuthRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/login', (req, reply) => {
    if (req.currentUser) {
      return reply.redirect('/');
    }
    const csrfToken = reply.generateCsrf();
    return reply.view('login.eta', {
      title: 'Sign in',
      csrfToken,
      flash: null,
      username: '',
    });
  });

  app.post(
    '/login',
    {
      preValidation: csrfPreValidation,
    },
    async (req, reply) => {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) {
        const csrfToken = reply.generateCsrf();
        return reply.code(400).view('login.eta', {
          title: 'Sign in',
          csrfToken,
          flash: 'Please fill in both fields.',
          username: '',
        });
      }

      const ipHash = hashIp(req.ip, config.SESSION_SECRET);
      const result = await app.services.auth.login({
        username: parsed.data.username,
        password: parsed.data.password,
        userAgent: req.headers['user-agent'] ?? '',
        ipHash,
      });

      if (result.kind === 'ok') {
        reply.setCookie(COOKIE_NAME, result.sessionId, {
          ...COOKIE_BASE_OPTS,
          expires: result.expiresAt,
        });
        return reply.redirect('/');
      }

      const csrfToken = reply.generateCsrf();
      const flash =
        result.kind === 'account_locked'
          ? `Account locked until ${result.until.toISOString()}.`
          : result.kind === 'account_inactive'
            ? 'This account is inactive.'
            : 'Username or password is incorrect.';
      return reply.code(401).view('login.eta', {
        title: 'Sign in',
        csrfToken,
        flash,
        username: parsed.data.username,
      });
    },
  );

  app.post(
    '/logout',
    {
      preValidation: csrfPreValidation,
    },
    async (req, reply) => {
      if (req.sessionId && req.currentUser) {
        await app.services.auth.logout(req.sessionId, {
          userId: req.currentUser.id,
          role: req.currentUser.role,
        });
      }
      reply.clearCookie(COOKIE_NAME, { ...COOKIE_BASE_OPTS });
      return reply.redirect('/login');
    },
  );
}
