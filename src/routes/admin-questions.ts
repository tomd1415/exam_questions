import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canManageClasses } from '../services/classes.js';
import {
  QuestionAccessError,
  QuestionInvariantError,
  ApprovalTransitionError,
} from '../services/questions.js';
import type { ApprovalStatus, ListQuestionsFilters } from '../repos/questions.js';
import {
  EXPECTED_RESPONSE_TYPES,
  SOURCE_TYPES,
  type QuestionDraft,
  type MarkPointDraft,
  type MisconceptionDraft,
  type PartDraft,
} from '../lib/question-invariants.js';

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

const CsrfOnly = z.object({ _csrf: z.string().min(1) });

const RejectBody = z.object({
  _csrf: z.string().min(1),
  review_notes: z.string().trim().min(1).max(2000),
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

export function registerAdminQuestionRoutes(app: FastifyInstance): void {
  const csrfPreValidation = [app.csrfProtection.bind(app)];

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
      flash: readQueryFlash(req),
    });
  });

  app.get('/admin/questions/new', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const refs = await loadFormRefs(app);
    return reply.view('admin_question_form.eta', {
      title: 'New question',
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      mode: 'new',
      postUrl: '/admin/questions',
      refs,
      values: emptyFormValues(),
      issues: [],
      flash: null,
    });
  });

  app.post('/admin/questions', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const draft = parseQuestionForm(req.body);
    try {
      const id = await app.services.questions.createDraft(actor, draft);
      return reply.redirect(`/admin/questions/${id}?flash=${encodeURIComponent('Draft created.')}`);
    } catch (err) {
      if (err instanceof QuestionInvariantError) {
        const refs = await loadFormRefs(app);
        return reply.code(400).view('admin_question_form.eta', {
          title: 'New question',
          currentUser: req.currentUser,
          csrfToken: reply.generateCsrf(),
          mode: 'new',
          postUrl: '/admin/questions',
          refs,
          values: formValuesFromDraft(draft),
          issues: err.issues,
          flash: 'Please fix the highlighted fields.',
        });
      }
      if (err instanceof QuestionAccessError) return reply.code(403).send('Forbidden');
      throw err;
    }
  });

  app.get('/admin/questions/:id/edit', async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');

    const questionId = String(params.data.id);
    const meta = await app.repos.questions.findApprovalMeta(questionId);
    if (!meta) return reply.code(404).send('Question not found');
    if (actor.role !== 'admin' && meta.created_by !== actor.id)
      return reply.code(403).send('Forbidden');

    const data = await app.repos.questions.getQuestionWithPartsAndMarkPoints(questionId);
    if (!data) return reply.code(404).send('Question not found');

    const refs = await loadFormRefs(app);
    return reply.view('admin_question_form.eta', {
      title: `Edit question · ${questionId}`,
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      mode: 'edit',
      postUrl: `/admin/questions/${questionId}`,
      refs,
      values: formValuesFromDetail(data),
      issues: [],
      flash: null,
    });
  });

  app.post('/admin/questions/:id', { preValidation: csrfPreValidation }, async (req, reply) => {
    const actor = requireTeacherOrAdmin(req, reply);
    if (!actor) return reply;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send('Not found');
    const questionId = String(params.data.id);

    const draft = parseQuestionForm(req.body);
    try {
      await app.services.questions.updateDraft(actor, questionId, draft);
      return reply.redirect(
        `/admin/questions/${questionId}?flash=${encodeURIComponent('Draft updated.')}`,
      );
    } catch (err) {
      if (err instanceof QuestionInvariantError) {
        const refs = await loadFormRefs(app);
        return reply.code(400).view('admin_question_form.eta', {
          title: `Edit question · ${questionId}`,
          currentUser: req.currentUser,
          csrfToken: reply.generateCsrf(),
          mode: 'edit',
          postUrl: `/admin/questions/${questionId}`,
          refs,
          values: formValuesFromDraft(draft),
          issues: err.issues,
          flash: 'Please fix the highlighted fields.',
        });
      }
      if (err instanceof QuestionAccessError) {
        if (err.reason === 'not_found') return reply.code(404).send('Not found');
        return reply.code(403).send('Forbidden');
      }
      throw err;
    }
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

    const canEdit = actor.role === 'admin' || data.question.created_by_display_name !== null;
    return reply.view('admin_question_detail.eta', {
      title: `Question · ${data.question.id}`,
      currentUser: req.currentUser,
      csrfToken: reply.generateCsrf(),
      flash: readQueryFlash(req),
      canEdit,
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

  app.post(
    '/admin/questions/:id/approve',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = IdParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const body = CsrfOnly.safeParse(req.body);
      if (!body.success) return reply.code(400).send('Bad request');
      const questionId = String(params.data.id);
      try {
        await app.services.questions.setApprovalStatus(actor, questionId, 'approved');
        return reply.redirect(
          `/admin/questions/${questionId}?flash=${encodeURIComponent('Question approved.')}`,
        );
      } catch (err) {
        return handleApprovalError(err, reply, questionId);
      }
    },
  );

  app.post(
    '/admin/questions/:id/reject',
    { preValidation: csrfPreValidation },
    async (req, reply) => {
      const actor = requireTeacherOrAdmin(req, reply);
      if (!actor) return reply;
      const params = IdParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send('Not found');
      const body = RejectBody.safeParse(req.body);
      if (!body.success)
        return reply.redirect(
          `/admin/questions/${params.data.id}?flash=${encodeURIComponent(
            'A reject reason is required.',
          )}`,
        );
      const questionId = String(params.data.id);
      try {
        await app.services.questions.setApprovalStatus(
          actor,
          questionId,
          'rejected',
          body.data.review_notes,
        );
        return reply.redirect(
          `/admin/questions/${questionId}?flash=${encodeURIComponent('Question rejected.')}`,
        );
      } catch (err) {
        return handleApprovalError(err, reply, questionId);
      }
    },
  );
}

function handleApprovalError(err: unknown, reply: FastifyReply, questionId: string): FastifyReply {
  if (err instanceof QuestionAccessError) {
    if (err.reason === 'not_found') return reply.code(404).send('Not found');
    return reply.code(403).send('Forbidden');
  }
  if (err instanceof ApprovalTransitionError)
    return reply.redirect(
      `/admin/questions/${questionId}?flash=${encodeURIComponent(
        `Cannot move a ${err.from} question to ${err.to}.`,
      )}`,
    );
  if (err instanceof QuestionInvariantError)
    return reply.redirect(
      `/admin/questions/${questionId}?flash=${encodeURIComponent(
        err.issues[0]?.message ?? 'Invalid input.',
      )}`,
    );
  throw err;
}

function readQueryFlash(req: FastifyRequest): string | null {
  const q = req.query as { flash?: unknown };
  return typeof q.flash === 'string' && q.flash.length > 0 ? q.flash.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// Form shape + parser
// ---------------------------------------------------------------------------

export interface FormMarkPointValues {
  text: string;
  marks: string;
  is_required: boolean;
  alternatives: string;
}

export interface FormPartValues {
  part_label: string;
  prompt: string;
  marks: string;
  expected_response_type: string;
  mark_points: FormMarkPointValues[];
  misconceptions: { label: string; description: string }[];
}

export interface FormValues {
  component_code: string;
  topic_code: string;
  subtopic_code: string;
  command_word_code: string;
  archetype_code: string;
  stem: string;
  expected_response_type: string;
  model_answer: string;
  feedback_template: string;
  difficulty_band: string;
  difficulty_step: string;
  source_type: string;
  parts: FormPartValues[];
}

function emptyFormValues(): FormValues {
  return {
    component_code: '',
    topic_code: '',
    subtopic_code: '',
    command_word_code: '',
    archetype_code: '',
    stem: '',
    expected_response_type: 'short_text',
    model_answer: '',
    feedback_template: '',
    difficulty_band: '3',
    difficulty_step: '1',
    source_type: 'teacher',
    parts: [emptyFormPart('(a)')],
  };
}

function emptyFormPart(label: string): FormPartValues {
  return {
    part_label: label,
    prompt: '',
    marks: '1',
    expected_response_type: 'short_text',
    mark_points: [{ text: '', marks: '1', is_required: false, alternatives: '' }],
    misconceptions: [],
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseQuestionForm(body: unknown): QuestionDraft {
  const record = (body ?? {}) as Record<string, unknown>;
  const partsCount = clampInt(record['parts_count'], 0, 20);
  const parts: PartDraft[] = [];
  for (let i = 0; i < partsCount; i++) {
    parts.push(parsePart(record, i));
  }

  const sourceTypeRaw = str(record['source_type']);
  const source_type = (SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)
    ? (sourceTypeRaw as QuestionDraft['source_type'])
    : 'teacher';

  const feedback = str(record['feedback_template']).trim();

  return {
    component_code: str(record['component_code']),
    topic_code: str(record['topic_code']),
    subtopic_code: str(record['subtopic_code']),
    command_word_code: str(record['command_word_code']),
    archetype_code: str(record['archetype_code']),
    stem: str(record['stem']),
    expected_response_type: str(record['expected_response_type']),
    model_answer: str(record['model_answer']),
    feedback_template: feedback.length > 0 ? feedback : null,
    difficulty_band: clampInt(record['difficulty_band'], 1, 9, 3),
    difficulty_step: clampInt(record['difficulty_step'], 1, 3, 1),
    source_type,
    review_notes: null,
    parts,
  };
}

function parsePart(record: Record<string, unknown>, i: number): PartDraft {
  const prefix = `part_${i}`;
  const mpCount = clampInt(record[`${prefix}_mp_count`], 0, 20);
  const miscCount = clampInt(record[`${prefix}_misc_count`], 0, 20);

  const mark_points: MarkPointDraft[] = [];
  for (let j = 0; j < mpCount; j++) {
    const mpPrefix = `${prefix}_mp_${j}`;
    const alternatives = str(record[`${mpPrefix}_alternatives`])
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    mark_points.push({
      text: str(record[`${mpPrefix}_text`]),
      accepted_alternatives: alternatives,
      marks: clampInt(record[`${mpPrefix}_marks`], 0, 100, 1),
      is_required: str(record[`${mpPrefix}_required`]) === 'on',
    });
  }

  const misconceptions: MisconceptionDraft[] = [];
  for (let j = 0; j < miscCount; j++) {
    misconceptions.push({
      label: str(record[`${prefix}_misc_${j}_label`]),
      description: str(record[`${prefix}_misc_${j}_description`]),
    });
  }

  return {
    part_label: str(record[`${prefix}_label`]),
    prompt: str(record[`${prefix}_prompt`]),
    marks: clampInt(record[`${prefix}_marks`], 0, 100, 0),
    expected_response_type: str(record[`${prefix}_response_type`]),
    mark_points,
    misconceptions,
  };
}

function clampInt(v: unknown, min: number, max: number, dflt: number = min): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

async function loadFormRefs(app: FastifyInstance): Promise<{
  components: { code: string; title: string }[];
  topics: { code: string; component_code: string; title: string }[];
  subtopics: { code: string; topic_code: string; title: string }[];
  commandWords: { code: string; definition: string }[];
  archetypes: { code: string; description: string }[];
  expectedResponseTypes: readonly string[];
  sourceTypes: readonly string[];
}> {
  const [components, topics, subtopics, commandWords, archetypes] = await Promise.all([
    app.repos.curriculum.listComponents(),
    app.repos.curriculum.listTopics(),
    app.repos.curriculum.listSubtopics(),
    app.repos.curriculum.listCommandWords(),
    app.repos.curriculum.listArchetypes(),
  ]);
  return {
    components,
    topics,
    subtopics,
    commandWords,
    archetypes,
    expectedResponseTypes: EXPECTED_RESPONSE_TYPES,
    sourceTypes: SOURCE_TYPES,
  };
}

function formValuesFromDraft(draft: QuestionDraft): FormValues {
  return {
    component_code: draft.component_code,
    topic_code: draft.topic_code,
    subtopic_code: draft.subtopic_code,
    command_word_code: draft.command_word_code,
    archetype_code: draft.archetype_code,
    stem: draft.stem,
    expected_response_type: draft.expected_response_type,
    model_answer: draft.model_answer,
    feedback_template: draft.feedback_template ?? '',
    difficulty_band: String(draft.difficulty_band),
    difficulty_step: String(draft.difficulty_step),
    source_type: draft.source_type,
    parts: draft.parts.map((p) => ({
      part_label: p.part_label,
      prompt: p.prompt,
      marks: String(p.marks),
      expected_response_type: p.expected_response_type,
      mark_points: p.mark_points.map((mp) => ({
        text: mp.text,
        marks: String(mp.marks),
        is_required: mp.is_required,
        alternatives: mp.accepted_alternatives.join('\n'),
      })),
      misconceptions: p.misconceptions.map((m) => ({
        label: m.label,
        description: m.description,
      })),
    })),
  };
}

interface DetailShape {
  question: {
    component_code: string;
    topic_code: string;
    subtopic_code: string;
    command_word_code: string;
    archetype_code: string;
    stem: string;
    expected_response_type: string;
    model_answer: string;
    feedback_template: string | null;
    difficulty_band: number;
    difficulty_step: number;
    source_type: 'teacher' | 'imported_pattern' | 'ai_generated';
  };
  parts: {
    id: string;
    part_label: string;
    prompt: string;
    marks: number;
    expected_response_type: string;
  }[];
  markPointsByPart: Map<
    string,
    { text: string; accepted_alternatives: string[]; marks: number; is_required: boolean }[]
  >;
  misconceptionsByPart: Map<string, { label: string; description: string }[]>;
}

function formValuesFromDetail(data: DetailShape): FormValues {
  return {
    component_code: data.question.component_code,
    topic_code: data.question.topic_code,
    subtopic_code: data.question.subtopic_code,
    command_word_code: data.question.command_word_code,
    archetype_code: data.question.archetype_code,
    stem: data.question.stem,
    expected_response_type: data.question.expected_response_type,
    model_answer: data.question.model_answer,
    feedback_template: data.question.feedback_template ?? '',
    difficulty_band: String(data.question.difficulty_band),
    difficulty_step: String(data.question.difficulty_step),
    source_type: data.question.source_type,
    parts: data.parts.map((p) => ({
      part_label: p.part_label,
      prompt: p.prompt,
      marks: String(p.marks),
      expected_response_type: p.expected_response_type,
      mark_points: (data.markPointsByPart.get(p.id) ?? []).map((mp) => ({
        text: mp.text,
        marks: String(mp.marks),
        is_required: mp.is_required,
        alternatives: mp.accepted_alternatives.join('\n'),
      })),
      misconceptions: (data.misconceptionsByPart.get(p.id) ?? []).map((m) => ({
        label: m.label,
        description: m.description,
      })),
    })),
  };
}
