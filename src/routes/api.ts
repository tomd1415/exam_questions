// JSON discovery endpoints for external integrations and the in-app
// question wizard.
//
// Currently exposes a single route — GET /api/widgets — which returns
// the live widget registry as a JSON document with the same shape as
// the committed `docs/widgets.schema.json` snapshot. A wizard or MCP
// server can hit this endpoint to learn which question types exist,
// how their part_config is shaped, and what the markpoint convention
// is for each.
//
// The endpoint is authenticated to any logged-in teacher or admin —
// pupils never need it, and the descriptors leak no PII (just code
// and English copy that already lives in the repository).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { widgetRegistryDocument } from '../lib/widgets.js';

function requireTeacherOrAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.currentUser) {
    reply.code(401).send({ error: 'unauthorised' });
    return false;
  }
  if (req.currentUser.role !== 'teacher' && req.currentUser.role !== 'admin') {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

export function registerApiRoutes(app: FastifyInstance): void {
  app.get('/api/widgets', async (req, reply) => {
    if (!requireTeacherOrAdmin(req, reply)) return reply;
    return reply.send(widgetRegistryDocument());
  });
}
