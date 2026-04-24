import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ModerationError } from '../services/marking/moderation.js';
import { buildPupilAnswerView } from '../lib/pupil-answer-view.js';

// Admin-only moderation queue for LLM-flagged marks (chunk 3d).
// Teachers see their own pending-teacher queue at /admin/attempts;
// this route is a separate, narrower surface for safety-gate hits.

const ItemParams = z.object({ id: z.coerce.number().int().positive() });

const OverrideBody = z.object({
  marks_awarded: z.coerce.number().int().min(0).max(100),
  reason: z.string().trim().min(1).max(500),
  _csrf: z.string().min(1),
});

const AcceptBody = z.object({ _csrf: z.string().min(1) });

// Chunk 3i. Pilot-shadow review: same shape as an override. A
// separate constant keeps the intent explicit at the call site.
const PilotReviewBody = OverrideBody;

const QueueQuery = z.object({
  mode: z.enum(['default', 'pilot']).default('default'),
});

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

export function registerAdminModerationRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  app.get('/admin/moderation', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return reply;
    const mode = QueueQuery.safeParse(req.query).data?.mode ?? 'default';
    const queue =
      mode === 'pilot'
        ? await app.services.moderation.listPilotQueue(actor)
        : await app.services.moderation.listQueue(actor);
    const items = queue.map((row) => ({
      awarded_mark_id: row.awarded_mark_id,
      attempt_id: row.attempt_id,
      class_name: row.class_name,
      pupil_display_name: row.pupil_display_name,
      pupil_pseudonym: row.pupil_pseudonym,
      topic_code: row.topic_code,
      part_label: row.part_label,
      marks_awarded: row.marks_awarded,
      marks_total: row.marks_total,
      confidence: row.confidence,
      flagged_at: row.flagged_at,
      reasons: summariseReasons(row.moderation_notes),
    }));
    return reply.view('admin_moderation_queue.eta', {
      title: mode === 'pilot' ? 'Pilot shadow queue' : 'AI moderation queue',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      items,
      total: items.length,
      flash: readQueryFlash(req),
      mode,
    });
  });

  app.get('/admin/moderation/:id', async (req, reply) => {
    const actor = requireAdmin(req, reply);
    if (!actor) return reply;
    const params = ItemParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const mode = QueueQuery.safeParse(req.query).data?.mode ?? 'default';
    try {
      const detail = await app.services.moderation.findDetail(actor, String(params.data.id));
      const markPoints = await app.repos.attempts.listMarkPointsForAttemptPart(
        detail.attempt_part_id,
      );
      const hitSet = new Set(detail.mark_points_hit ?? []);
      const missedSet = new Set(detail.mark_points_missed ?? []);
      const answerView = buildPupilAnswerView(
        detail.raw_answer,
        detail.expected_response_type,
        detail.part_config,
      );
      return reply.view('admin_moderation_detail.eta', {
        title: mode === 'pilot' ? 'Pilot shadow review' : 'Moderation review',
        currentUser: req.currentUser,
        csrfToken: reply.generateCsrf(),
        detail,
        reasons: expandReasons(detail.moderation_notes),
        markPoints: markPoints.map((mp) => ({
          id: mp.id,
          text: mp.text,
          marks: mp.marks,
          is_required: mp.is_required,
          hit: hitSet.has(mp.id),
          missed: missedSet.has(mp.id),
        })),
        evidenceQuotes: detail.evidence_quotes,
        highlightedAnswerHtml: highlightEvidence(
          detail.raw_answer ?? '',
          detail.evidence_quotes ?? [],
        ),
        answerView,
        flash: readQueryFlash(req),
        mode,
      });
    } catch (err) {
      if (err instanceof ModerationError && err.reason === 'not_found') {
        return reply.code(404).send('Not found');
      }
      throw err;
    }
  });

  app.post(
    '/admin/moderation/:id/accept',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireAdmin(req, reply);
      if (!actor) return reply;
      const params = ItemParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = AcceptBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send('Bad request');
      try {
        await app.services.moderation.accept(actor, String(params.data.id));
        return reply.redirect(`/admin/moderation?flash=${encodeURIComponent('Mark accepted.')}`);
      } catch (err) {
        return handleModerationError(err, reply, String(params.data.id));
      }
    },
  );

  app.post(
    '/admin/moderation/:id/override',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireAdmin(req, reply);
      if (!actor) return reply;
      const params = ItemParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = OverrideBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.redirect(
          `/admin/moderation/${params.data.id}?flash=${encodeURIComponent(
            'Enter a whole-number mark and a short reason (up to 500 characters).',
          )}`,
        );
      }
      try {
        await app.services.moderation.override(actor, {
          awardedMarkId: String(params.data.id),
          marksAwarded: parsed.data.marks_awarded,
          reason: parsed.data.reason,
        });
        return reply.redirect(`/admin/moderation?flash=${encodeURIComponent('Mark overridden.')}`);
      } catch (err) {
        return handleModerationError(err, reply, String(params.data.id));
      }
    },
  );

  // Chunk 3i. Pilot-shadow review endpoint. Accepts the teacher's
  // mark + reason for a pilot row. Always writes a teacher_override
  // row even when the marks match so the pilot-report CSV can count
  // agreement decisions as a positive signal.
  app.post(
    '/admin/moderation/:id/pilot-review',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireAdmin(req, reply);
      if (!actor) return reply;
      const params = ItemParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const parsed = PilotReviewBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.redirect(
          `/admin/moderation/${params.data.id}?mode=pilot&flash=${encodeURIComponent(
            'Enter a whole-number mark and a short reason (up to 500 characters).',
          )}`,
        );
      }
      try {
        await app.services.moderation.recordPilotShadowReview(actor, {
          awardedMarkId: String(params.data.id),
          teacherMarksAwarded: parsed.data.marks_awarded,
          reason: parsed.data.reason,
        });
        return reply.redirect(
          `/admin/moderation?mode=pilot&flash=${encodeURIComponent('Shadow review recorded.')}`,
        );
      } catch (err) {
        return handleModerationError(err, reply, String(params.data.id));
      }
    },
  );
}

function handleModerationError(
  err: unknown,
  reply: FastifyReply,
  id: string,
): FastifyReply | Promise<void> {
  if (err instanceof ModerationError) {
    if (err.reason === 'not_found') return reply.code(404).send('Not found');
    if (err.reason === 'not_admin') return reply.code(403).send('Forbidden');
    const message =
      err.reason === 'already_resolved'
        ? 'This item has already been resolved.'
        : err.reason === 'invalid_marks'
          ? 'Mark is outside the allowed range for that part.'
          : err.reason === 'invalid_reason'
            ? 'A short reason is required.'
            : 'Could not save the moderation decision.';
    return reply.redirect(`/admin/moderation/${id}?flash=${encodeURIComponent(message)}`);
  }
  throw err;
}

// moderation_notes is SafetyGateReason[] stored as JSONB. The queue
// list view only needs one-word summaries per reason; the detail
// page uses expandReasons() for the full rendering.
function summariseReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const kinds: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const kind = r['kind'];
    if (typeof kind === 'string') kinds.push(kind);
  }
  return kinds;
}

function expandReasons(raw: unknown): ReadableReason[] {
  if (!Array.isArray(raw)) return [];
  const out: ReadableReason[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !('kind' in item)) continue;
    const r = item as Record<string, unknown>;
    const kind = r['kind'];
    if (typeof kind !== 'string') continue;
    switch (kind) {
      case 'low_confidence':
        out.push({
          kind,
          label: 'Low confidence',
          detail: `Model returned confidence ${formatNumber(r['confidence'])} (threshold ${formatNumber(r['threshold'])}).`,
        });
        break;
      case 'marks_without_evidence':
        out.push({
          kind,
          label: 'Marks awarded without evidence',
          detail: `${stringifyScalar(r['marksAwarded'], '0')} marks awarded but no mark point was recorded as hit.`,
        });
        break;
      case 'evidence_not_in_answer':
        out.push({
          kind,
          label: 'Evidence quote not in pupil answer',
          detail: typeof r['quote'] === 'string' ? r['quote'] : '(unknown quote)',
        });
        break;
      case 'marks_clipped':
        out.push({
          kind,
          label: 'Marks awarded exceeded the part total',
          detail: `Model requested ${stringifyScalar(r['rawAwarded'], '?')} but the part is only worth ${stringifyScalar(r['marksTotal'], '?')}.`,
        });
        break;
      case 'safeguarding_pattern':
        out.push({
          kind,
          label: 'Safeguarding pattern matched',
          detail:
            typeof r['pattern'] === 'string' ? `Matched phrase: ${r['pattern']}` : '(unknown)',
        });
        break;
      case 'prompt_injection_pattern':
        out.push({
          kind,
          label: 'Prompt-injection pattern matched',
          detail:
            typeof r['pattern'] === 'string' ? `Matched phrase: ${r['pattern']}` : '(unknown)',
        });
        break;
      default:
        out.push({ kind, label: kind, detail: '' });
    }
  }
  return out;
}

interface ReadableReason {
  kind: string;
  label: string;
  detail: string;
}

function formatNumber(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  return n.toFixed(2);
}

function stringifyScalar(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Wrap each evidence-quote occurrence in the pupil's raw answer with
// a <mark class="evidence-highlight">. Case-insensitive substring
// match; overlapping matches are collapsed so the output HTML is
// always well-formed. Done server-side so the page works without JS.
function highlightEvidence(text: string, quotes: readonly string[]): string {
  if (!text) return '';
  const ranges: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const qraw of quotes) {
    const q = qraw.trim();
    if (!q) continue;
    const ql = q.toLowerCase();
    let from = 0;
    while (true) {
      const idx = lower.indexOf(ql, from);
      if (idx === -1) break;
      ranges.push([idx, idx + ql.length]);
      from = idx + ql.length;
    }
  }
  if (ranges.length === 0) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [[ranges[0]![0], ranges[0]![1]]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]!;
    const cur = ranges[i]!;
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else merged.push([cur[0], cur[1]]);
  }
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += escapeHtml(text.slice(cursor, start));
    out += `<mark class="evidence-highlight">${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}
