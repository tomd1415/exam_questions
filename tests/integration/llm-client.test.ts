import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { PromptVersionRepo, type PromptVersionRow } from '../../src/repos/prompts.js';
import { LlmCallRepo } from '../../src/repos/llm_calls.js';
import { LlmClient, redactPii } from '../../src/services/llm/client.js';
import { getSharedPool } from '../helpers/db.js';

const pool = getSharedPool();
const promptRepo = new PromptVersionRepo(pool);
const llmCallRepo = new LlmCallRepo(pool);

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: { result: { type: 'string' } },
};

async function seedPromptVersion(): Promise<PromptVersionRow> {
  return promptRepo.insert({
    name: `test_client_${randomBytes(4).toString('hex')}`,
    version: 'v0.1.0',
    modelId: 'gpt-5-mini',
    systemPrompt: 'You are a test marker.',
    outputSchema: OUTPUT_SCHEMA,
    status: 'draft',
  });
}

async function countCallsForPrompt(promptVersionId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM llm_calls WHERE prompt_version_id = $1::bigint`,
    [promptVersionId],
  );
  return Number(rows[0]!.count);
}

async function latestCall(promptVersionId: string) {
  const { rows } = await pool.query<{
    status: string;
    input_tokens: number;
    output_tokens: number;
    cost_pence: number;
    error_message: string | null;
  }>(
    `SELECT status, input_tokens, output_tokens, cost_pence, error_message
       FROM llm_calls WHERE prompt_version_id = $1::bigint
       ORDER BY id DESC LIMIT 1`,
    [promptVersionId],
  );
  return rows[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okResponse(text: string) {
  return jsonResponse({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 123, output_tokens: 45 },
  });
}

function refusalResponse(reason: string) {
  return jsonResponse({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: reason }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 0 },
  });
}

function makeFetchStub(handlers: (() => Response | Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    const handler = handlers[i++] ?? handlers[handlers.length - 1];
    if (!handler) throw new Error('no fetch handler configured');
    return handler();
  };
  return { fetchImpl, calls };
}

function buildClient(fetchImpl: typeof fetch): LlmClient {
  return new LlmClient(llmCallRepo, {
    apiKey: 'test-key',
    endpoint: 'https://api.test.invalid/v1/responses',
    fetchImpl,
    timeoutMs: 100,
  });
}

describe('redactPii', () => {
  it('replaces email addresses', () => {
    expect(redactPii('contact me at pupil.a@example.com please')).toBe(
      'contact me at [REDACTED_EMAIL] please',
    );
  });

  it('leaves text without email addresses alone', () => {
    expect(redactPii('no email here')).toBe('no email here');
  });
});

describe('LlmClient.callResponses', () => {
  it('returns ok and writes a row when the response is valid', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl, calls } = makeFetchStub([() => okResponse('{"result":"hello"}')]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'an answer',
      questionContext: 'a question',
      attemptPartId: null,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.payload).toEqual({ result: 'hello' });
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    expect(calls).toHaveLength(1);

    const row = await latestCall(pv.id);
    expect(row?.status).toBe('ok');
    expect(row?.input_tokens).toBe(123);
    expect(row?.output_tokens).toBe(45);
    expect(row?.cost_pence).toBeGreaterThan(0);
  });

  it('flags schema_invalid and writes a row when the body fails validation', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl } = makeFetchStub([() => okResponse('{"unexpected":"field"}')]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(result.kind).toBe('schema_invalid');
    const row = await latestCall(pv.id);
    expect(row?.status).toBe('schema_invalid');
    expect(row?.error_message).toBeTruthy();
  });

  it('surfaces a refusal and writes a row', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl } = makeFetchStub([() => refusalResponse('cannot comply')]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') throw new Error('unreachable');
    expect(result.message).toBe('cannot comply');
    const row = await latestCall(pv.id);
    expect(row?.status).toBe('refusal');
  });

  it('retries once on HTTP 503 and succeeds', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl, calls } = makeFetchStub([
      () => jsonResponse({ error: 'overloaded' }, 503),
      () => okResponse('{"result":"recovered"}'),
    ]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(result.kind).toBe('ok');
    expect(calls).toHaveLength(2);
    const row = await latestCall(pv.id);
    expect(row?.status).toBe('ok');
  });

  it('does not retry on 4xx', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl, calls } = makeFetchStub([() => jsonResponse({ error: 'bad' }, 400)]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(result.kind).toBe('http_error');
    if (result.kind !== 'http_error') throw new Error('unreachable');
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(1);
    const row = await latestCall(pv.id);
    expect(row?.status).toBe('http_error');
    expect(row?.cost_pence).toBe(0);
  });

  it('records http_error after two 503s', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl, calls } = makeFetchStub([
      () => jsonResponse({ error: 'overloaded' }, 503),
      () => jsonResponse({ error: 'still overloaded' }, 503),
    ]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(result.kind).toBe('http_error');
    expect(calls).toHaveLength(2);
    const row = await latestCall(pv.id);
    expect(row?.status).toBe('http_error');
  });

  it('records timeout and retries once when fetch aborts', async () => {
    const pv = await seedPromptVersion();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetchImpl, calls } = makeFetchStub([
      () => Promise.reject(abortError),
      () => Promise.reject(abortError),
    ]);
    const client = buildClient(fetchImpl);

    const result = await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(result.kind).toBe('timeout');
    expect(calls).toHaveLength(2);
    const row = await latestCall(pv.id);
    expect(row?.status).toBe('timeout');
  });

  it('redacts email addresses from the outgoing prompt input', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl, calls } = makeFetchStub([() => okResponse('{"result":"x"}')]);
    const client = buildClient(fetchImpl);

    await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'please email me at pupil@school.example',
      questionContext: 'contact teacher@example.org if stuck',
      attemptPartId: null,
    });

    const sentBody = calls[0]?.body as { input: { role: string; content: string }[] };
    const userContent = sentBody.input.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).not.toContain('pupil@school.example');
    expect(userContent).not.toContain('teacher@example.org');
    expect(userContent).toContain('[REDACTED_EMAIL]');
  });

  it('writes exactly one row per outcome even under retry', async () => {
    const pv = await seedPromptVersion();
    const { fetchImpl } = makeFetchStub([
      () => jsonResponse({ error: 'overloaded' }, 503),
      () => okResponse('{"result":"ok"}'),
    ]);
    const client = buildClient(fetchImpl);

    await client.callResponses({
      promptVersion: pv,
      pupilAnswer: 'a',
      questionContext: 'q',
      attemptPartId: null,
    });

    expect(await countCallsForPrompt(pv.id)).toBe(1);
  });
});
