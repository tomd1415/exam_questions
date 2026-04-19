import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { canManageClasses } from '../services/classes.js';
import {
  DraftAccessError,
  DraftStateError,
  type ActorForDraft,
} from '../services/question_drafts.js';
import {
  parseWizardStep,
  widgetChoicesFor,
  type StepIssue,
  type StepParseContext,
} from '../lib/wizard-steps.js';
import { widgetDescriptors, type WidgetDescriptor } from '../lib/widgets.js';
import { widgetAutoDerivesMarkPoints } from '../lib/wizard-widget-editors.js';
import { EXPECTED_RESPONSE_TYPES } from '../lib/question-invariants.js';
import type {
  ComponentRow,
  TopicRow,
  SubtopicRow,
  CommandWordRow,
  ArchetypeRow,
} from '../repos/curriculum.js';
import type { QuestionDraftPayload, QuestionDraftRow } from '../repos/question_drafts.js';

// The wizard is its own route file (not bolted onto admin-questions.ts) so the
// nine GET / nine POST endpoints, the "My drafts" list, and the publish action
// can grow per-step UX without tangling with the existing single-page admin
// form. The single-page form at /admin/questions/new stays for the Phase-3
// "I just need to fix one field" path; the wizard is the authoring path.

const StepParams = z.object({
  draftId: z.coerce.number().int().positive(),
  n: z.coerce.number().int().min(1).max(9),
});

const DraftIdParams = z.object({
  draftId: z.coerce.number().int().positive(),
});

const CsrfOnly = z.object({ _csrf: z.string().min(1) });

interface WizardRefs {
  components: ComponentRow[];
  topics: TopicRow[];
  subtopics: SubtopicRow[];
  commandWords: CommandWordRow[];
  archetypes: ArchetypeRow[];
}

function requireTeacherOrAdmin(req: FastifyRequest, reply: FastifyReply): ActorForDraft | null {
  if (!req.currentUser) {
    reply.redirect('/login');
    return null;
  }
  if (!canManageClasses(req.currentUser)) {
    reply.code(403).send('Forbidden');
    return null;
  }
  return { id: req.currentUser.id, role: req.currentUser.role };
}

// Flag is read at call time so a test can flip process.env between
// requests without reloading the config module. Config.ts still validates
// the env at startup; this helper is strictly a runtime read. The
// production flag row in app_settings lands in chunk 2.5t alongside the
// flag flip.
function isWizardV2Enabled(): boolean {
  const raw = process.env['WIZARD_V2_ENABLED'];
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return config.WIZARD_V2_ENABLED;
}

export interface DraftsListFilters {
  tab: 'in-progress' | 'published' | 'all';
  q?: string;
  widget?: string;
  topic?: string;
  stale?: 'all' | 'fresh' | 'aging' | 'stale';
}

const DRAFTS_FILTER_TABS = ['in-progress', 'published', 'all'] as const;
const DRAFTS_STALE_BUCKETS = ['all', 'fresh', 'aging', 'stale'] as const;

function parseDraftsListFilters(query: unknown): DraftsListFilters {
  const q = (query ?? {}) as Record<string, unknown>;
  const read = (key: string): string => (typeof q[key] === 'string' ? q[key] : '');
  const tabRaw = read('tab');
  const staleRaw = read('stale');
  return {
    tab: (DRAFTS_FILTER_TABS as readonly string[]).includes(tabRaw)
      ? (tabRaw as DraftsListFilters['tab'])
      : 'in-progress',
    q: read('q').slice(0, 200),
    widget: read('widget').slice(0, 80),
    topic: read('topic').slice(0, 80),
    stale: (DRAFTS_STALE_BUCKETS as readonly string[]).includes(staleRaw)
      ? (staleRaw as NonNullable<DraftsListFilters['stale']>)
      : 'all',
  };
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}

function handleDraftError(err: unknown, reply: FastifyReply, draftId: string | null): FastifyReply {
  if (err instanceof DraftAccessError) {
    if (err.reason === 'not_found') return reply.code(404).send('Draft not found');
    return reply.code(403).send('Forbidden');
  }
  if (err instanceof DraftStateError) {
    if (err.reason === 'already_published' && draftId) {
      return reply.redirect(
        `/admin/questions/wizard/${draftId}/step/9?flash=${encodeURIComponent(
          'This draft has already been published.',
        )}`,
      );
    }
    if (err.reason === 'incomplete_for_publish' && draftId) {
      return reply.redirect(
        `/admin/questions/wizard/${draftId}/step/9?flash=${encodeURIComponent(
          'Finish every step before publishing.',
        )}`,
      );
    }
    return reply.code(400).send('Bad request');
  }
  throw err;
}

async function loadRefs(app: FastifyInstance): Promise<WizardRefs> {
  const [components, topics, subtopics, commandWords, archetypes] = await Promise.all([
    app.repos.curriculum.listComponents(),
    app.repos.curriculum.listTopics(),
    app.repos.curriculum.listSubtopics(),
    app.repos.curriculum.listCommandWords(),
    app.repos.curriculum.listArchetypes(),
  ]);
  return { components, topics, subtopics, commandWords, archetypes };
}

function buildStepContext(refs: WizardRefs, payload: QuestionDraftPayload): StepParseContext {
  return {
    currentPayload: payload,
    components: refs.components.map((c) => c.code),
    topicComponent: new Map(refs.topics.map((t) => [t.code, t.component_code])),
    subtopicTopic: new Map(refs.subtopics.map((s) => [s.code, s.topic_code])),
    commandWords: new Set(refs.commandWords.map((c) => c.code)),
    archetypes: new Set(refs.archetypes.map((a) => a.code)),
  };
}

function widgetGroupsForDraft(payload: QuestionDraftPayload): {
  recommended: WidgetDescriptor[];
  other: WidgetDescriptor[];
} {
  const { recommended, other } = widgetChoicesFor(payload.command_word_code);
  const all = widgetDescriptors();
  const byType = new Map(all.map((w) => [w.type, w]));
  return {
    recommended: recommended.map((t) => byType.get(t)!).filter((w) => w !== undefined),
    other: other.map((t) => byType.get(t)!).filter((w) => w !== undefined),
  };
}

// Lists, in plain English, what the teacher still has to fill in before
// publishing. Used by step 9 to show a "not ready" notice (the publish
// button is still there; the service enforces the real gate).
function missingFieldsForPublish(payload: QuestionDraftPayload): string[] {
  const missing: string[] = [];
  if (!payload.component_code || !payload.topic_code || !payload.subtopic_code)
    missing.push('Step 1: component, topic, and subtopic');
  if (!payload.command_word_code || !payload.archetype_code)
    missing.push('Step 2: command word and archetype');
  if (!payload.expected_response_type) missing.push('Step 3: widget choice');
  if (!payload.stem) missing.push('Step 4: stem');
  if (!payload.model_answer) missing.push('Step 6: model answer');
  const part = payload.parts?.[0];
  if (!part) missing.push('Step 6: mark points');
  else {
    if (!part.mark_points || part.mark_points.length === 0)
      missing.push('Step 6: at least one mark point');
    if (!part.marks || part.marks < 1) missing.push('Step 6: marks total');
  }
  if (!payload.difficulty_band || !payload.difficulty_step)
    missing.push('Step 8: difficulty band and step');
  return missing;
}

async function renderStep(
  reply: FastifyReply,
  req: FastifyRequest,
  draft: QuestionDraftRow,
  n: number,
  refs: WizardRefs,
  opts: {
    issues?: StepIssue[];
    flash?: string | null;
    status?: number;
    recentWidgets?: string[];
    // Raw form body from the failed POST. When present, step-5 templates
    // echo these values back into their textareas/inputs instead of
    // re-deriving them from the saved part_config — otherwise the teacher
    // loses everything they typed the moment a validation error fires.
    formEcho?: unknown;
  } = {},
): Promise<FastifyReply> {
  const widgets = n === 3 ? widgetGroupsForDraft(draft.payload) : null;
  const recentWidgets = n === 3 ? (opts.recentWidgets ?? []) : [];
  const missing = n === 9 ? missingFieldsForPublish(draft.payload) : [];
  const publishReady = n === 9 ? missing.length === 0 : false;
  if (opts.status) reply.code(opts.status);
  const v2 = isWizardV2Enabled();
  const template = v2 ? 'v2/admin_wizard_step.eta' : 'admin_wizard_step.eta';
  return reply.view(template, {
    title: `Step ${n} of 9`,
    currentUser: req.currentUser,
    csrfToken: reply.generateCsrf(),
    draft,
    step: n,
    flash: opts.flash ?? readQueryFlash(req),
    issues: opts.issues ?? [],
    refs,
    widgets,
    recentWidgets,
    missingFields: missing,
    publishReady,
    autoDerivedMarkPointWidgets: AUTO_DERIVED_MARK_POINT_WIDGETS,
    formEcho: opts.formEcho ?? null,
    // Loads /static/wizard_curriculum_chain.js for the topic/subtopic
    // dependent-select enhancement on step 1. Cheap to ship on every step
    // (the script no-ops when its selectors aren't on the page) but we
    // still gate it on step 1 so the network panel stays clean.
    wizardScriptsEnabled: n === 1,
    // Loads /static/wizard_answer_picker.js (and the diagram_labels
    // hotspot picker) so the per-widget editor's correct-answer UI
    // rebuilds live as the teacher edits the source textareas. Only
    // the widget-config step needs them.
    wizardAnswerPickerEnabled: n === 5,
    // Loads the pupil-widget runtime scripts so the step-9 preview pane
    // is interactive (cloze bank drag-drop, matching, logic_diagram,
    // flowchart, trace_grid, widget counters). On v1 only step 9 renders
    // the preview; on v2 it's mounted on steps 5–9, so any of those steps
    // needs the runtime. Steps 1–4 don't render a preview on either flag.
    wizardPreviewEnabled: v2 ? n >= 5 : n === 9,
    // Loads /static/v2/wizard_shell.js for the 3-pane shell's responsive
    // collapse behaviour (preview drawer below 1024 px). Only the v2
    // wizard-step template renders the toggle the script binds to, so we
    // gate the script on the flag.
    wizardV2ShellEnabled: v2,
  });
}

// Materialised list of widget types whose mark_points come from step 4
// (e.g. multiple_choice's "tick the correct option(s)"). Built from the
// registry helper so the wizard route and the editor library stay in sync.
const AUTO_DERIVED_MARK_POINT_WIDGETS: readonly string[] = EXPECTED_RESPONSE_TYPES.filter(
  widgetAutoDerivesMarkPoints,
);

export function registerAdminQuestionWizardRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

  // List the actor's drafts. Used as the wizard's landing page; teachers
  // come here from /admin/questions to resume or start a new draft.
  app.get('/admin/questions/wizard', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const drafts = await app.services.questionDrafts.listForActor(actor);
    const v2 = isWizardV2Enabled();
    const template = v2 ? 'v2/admin_drafts_list.eta' : 'admin_drafts_list.eta';
    const filters = v2 ? parseDraftsListFilters(req.query) : undefined;
    return reply.view(template, {
      title: v2 ? 'Your question drafts' : 'My question drafts',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      drafts,
      filters,
      flash: readQueryFlash(req),
      wizardV2DraftsEnabled: v2,
    });
  });

  // Create a new draft and redirect to step 1. POST so the create is not
  // accidentally re-triggered by a back-button or pre-fetch.
  app.post(
    '/admin/questions/wizard/new',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const draftId = await app.services.questionDrafts.create(actor);
      return reply.redirect(`/admin/questions/wizard/${draftId}/step/1`);
    },
  );

  // Render a wizard step. The route doesn't enforce step ≤ current_step + 1
  // (so an author can revisit any step they've already touched), but step 9
  // checks the payload is publish-ready before showing the publish button.
  app.get('/admin/questions/wizard/:draftId/step/:n', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = StepParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const { draftId, n } = params.data;
    const draftIdStr = String(draftId);

    let draft;
    try {
      draft = await app.services.questionDrafts.findForActor(actor, draftIdStr);
    } catch (err) {
      return handleDraftError(err, reply, draftIdStr);
    }

    const refs = await loadRefs(app);
    const recentWidgets =
      n === 3 && isWizardV2Enabled()
        ? await app.services.questionDrafts.recentWidgetsForActor(actor, 4)
        : [];
    return renderStep(reply, req, draft, n, refs, { recentWidgets });
  });

  // Advance a step. The per-step parser in src/lib/wizard-steps.ts turns the
  // form body into a Partial<QuestionDraft> patch. If parsing fails we
  // re-render the same step with 400 + field-level issues; otherwise we
  // hand the patch to the draft service, which merges it into the payload,
  // bumps current_step, and records an audit event.
  app.post(
    '/admin/questions/wizard/:draftId/step/:n',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = StepParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const csrf = CsrfOnly.safeParse(req.body);
      if (!csrf.success) return reply.code(400).send('Bad request');
      const { draftId, n } = params.data;
      const draftIdStr = String(draftId);

      let draft: QuestionDraftRow;
      try {
        draft = await app.services.questionDrafts.findForActor(actor, draftIdStr);
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }

      const refs = await loadRefs(app);
      const ctx = buildStepContext(refs, draft.payload);
      const parsed = parseWizardStep(n, req.body, ctx);
      if (!parsed.ok) {
        return renderStep(reply, req, draft, n, refs, {
          issues: parsed.issues,
          flash: 'Please fix the highlighted fields.',
          status: 400,
          // Pass the raw form body through so step-5 widget editors can
          // echo it into their textareas/inputs instead of reverting to
          // the last-saved part_config.
          formEcho: req.body,
        });
      }

      try {
        const updated = await app.services.questionDrafts.advance(
          actor,
          draftIdStr,
          n,
          parsed.patch,
        );
        // Step 9's save stays on 9 (advance caps current_step at 9).
        const next = Math.min(9, Math.max(n + 1, updated.current_step));
        return reply.redirect(`/admin/questions/wizard/${draftIdStr}/step/${next}`);
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }
    },
  );

  // Autosave: merge the step patch into payload without advancing
  // current_step, without emitting an audit event, and return 204 on
  // success. The route re-uses parseWizardStep so validation is
  // identical to the advance POST — malformed bodies get a 422 with
  // the same StepIssue[] shape the v2 inline-errors JS expects. Only
  // reachable on the v2 wizard since the v1 template doesn't ship the
  // autosave client.
  app.post(
    '/admin/questions/wizard/:draftId/step/:n/autosave',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = StepParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const csrf = CsrfOnly.safeParse(req.body);
      if (!csrf.success) return reply.code(400).send('Bad request');
      const { draftId, n } = params.data;
      const draftIdStr = String(draftId);

      let draft: QuestionDraftRow;
      try {
        draft = await app.services.questionDrafts.findForActor(actor, draftIdStr);
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }

      const refs = await loadRefs(app);
      const ctx = buildStepContext(refs, draft.payload);
      const parsed = parseWizardStep(n, req.body, ctx);
      if (!parsed.ok) {
        return reply.code(422).send({ ok: false, issues: parsed.issues });
      }

      try {
        await app.services.questionDrafts.autosave(actor, draftIdStr, n, parsed.patch);
        return reply.code(204).send();
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }
    },
  );

  // Publish the draft. Only step 9 calls this; the route guards on its own
  // because curl-style direct POSTs from anywhere else would otherwise sneak
  // through.
  app.post(
    '/admin/questions/wizard/:draftId/publish',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = DraftIdParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const csrf = CsrfOnly.safeParse(req.body);
      if (!csrf.success) return reply.code(400).send('Bad request');
      const draftIdStr = String(params.data.draftId);

      try {
        const { questionId } = await app.services.questionDrafts.publish(actor, draftIdStr);
        return reply.redirect(
          `/admin/questions/${questionId}?flash=${encodeURIComponent('Published from wizard.')}`,
        );
      } catch (err) {
        return handleDraftError(err, reply, draftIdStr);
      }
    },
  );
}
