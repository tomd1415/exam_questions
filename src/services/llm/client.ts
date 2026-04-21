import { Ajv, type ValidateFunction } from 'ajv';
import type { PromptVersionRow } from '../../repos/prompts.js';
import type { LlmCallRepo, LlmCallStatus } from '../../repos/llm_calls.js';
import { costPence } from './cost.js';

// Thin wrapper around the OpenAI Responses API. One entry point,
// one round of retry on 5xx or network timeout, one llm_calls row
// written per call regardless of outcome. That row-per-outcome
// invariant is what makes the cost dashboard (chunk 3g) honest —
// if a refusal or schema failure could bypass the log, SUM() would
// understate the bill.
//
// No OpenAI SDK dependency. Node 22's global fetch keeps the wire
// format visible in this file and makes the tests in
// tests/integration/llm-client.test.ts trivial to stub by injecting
// a fake fetch into the constructor.

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface StructuredCallInput {
  readonly promptVersion: PromptVersionRow;
  readonly pupilAnswer: string;
  readonly questionContext: string;
  readonly attemptPartId: string | null;
}

export type StructuredCallResult =
  | {
      kind: 'ok';
      payload: unknown;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
      costPence: number;
    }
  | {
      kind: 'refusal';
      message: string;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
      costPence: number;
    }
  | {
      kind: 'schema_invalid';
      errors: string[];
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
      costPence: number;
    }
  | {
      kind: 'http_error';
      status: number;
      message: string;
      latencyMs: number;
    }
  | {
      kind: 'timeout';
      message: string;
      latencyMs: number;
    };

export interface LlmClientOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

// Minimal PII scrubber applied to anything we put in the prompt
// input. The risk model is narrow (pupil answers shouldn't contain
// the pupil's own email) but stripping anyway closes a dumb-leak
// path and keeps the test invariant simple to assert.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactPii(text: string): string {
  return text.replace(EMAIL_RE, '[REDACTED_EMAIL]');
}

// The `name` field in Structured Outputs must match ^[a-zA-Z0-9_-]+$.
// Prompt versions carry dots (v0.1.0) so flatten them to underscores.
function schemaName(promptVersion: PromptVersionRow): string {
  return `${promptVersion.name}__${promptVersion.version}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

interface ResponsesApiBody {
  model: string;
  input: { role: 'system' | 'user'; content: string }[];
  text: {
    format: {
      type: 'json_schema';
      name: string;
      strict: true;
      schema: unknown;
    };
  };
}

interface ResponsesApiOutput {
  output?: {
    type?: string;
    role?: string;
    content?: (
      | { type: 'output_text'; text: string }
      | { type: 'refusal'; refusal: string }
      | { type: string; [k: string]: unknown }
    )[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class LlmClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly repo: LlmCallRepo,
    private readonly opts: LlmClientOptions,
  ) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.ajv = new Ajv({ strict: false, allErrors: true });
  }

  async callResponses(input: StructuredCallInput): Promise<StructuredCallResult> {
    const start = this.now();
    const body: ResponsesApiBody = {
      model: input.promptVersion.model_id,
      input: [
        { role: 'system', content: input.promptVersion.system_prompt },
        {
          role: 'user',
          content: `${redactPii(input.questionContext)}\n\n---\n\n${redactPii(input.pupilAnswer)}`,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: schemaName(input.promptVersion),
          strict: true,
          schema: input.promptVersion.output_schema,
        },
      },
    };

    const transport = await this.send(body);
    const latencyMs = this.now() - start;

    if (transport.kind === 'timeout') {
      await this.logCall(input, 'timeout', 0, 0, latencyMs, transport.message);
      return { kind: 'timeout', message: transport.message, latencyMs };
    }
    if (transport.kind === 'http_error') {
      await this.logCall(input, 'http_error', 0, 0, latencyMs, transport.message);
      return {
        kind: 'http_error',
        status: transport.status,
        message: transport.message,
        latencyMs,
      };
    }

    const parsed = transport.body;
    const usage = {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    };
    const cost = costPence(input.promptVersion.model_id, usage.inputTokens, usage.outputTokens);

    const firstMessage = parsed.output?.find((o) => o.type === 'message');
    const refusal = firstMessage?.content?.find(
      (c): c is { type: 'refusal'; refusal: string } => c.type === 'refusal',
    );
    if (refusal) {
      await this.logCall(
        input,
        'refusal',
        usage.inputTokens,
        usage.outputTokens,
        latencyMs,
        refusal.refusal,
      );
      return { kind: 'refusal', message: refusal.refusal, usage, latencyMs, costPence: cost };
    }

    const outputText = firstMessage?.content?.find(
      (c): c is { type: 'output_text'; text: string } => c.type === 'output_text',
    );
    if (!outputText) {
      const message = 'no output_text in response';
      await this.logCall(
        input,
        'schema_invalid',
        usage.inputTokens,
        usage.outputTokens,
        latencyMs,
        message,
      );
      return {
        kind: 'schema_invalid',
        errors: [message],
        usage,
        latencyMs,
        costPence: cost,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(outputText.text);
    } catch (err) {
      const message = `JSON.parse failed: ${(err as Error).message}`;
      await this.logCall(
        input,
        'schema_invalid',
        usage.inputTokens,
        usage.outputTokens,
        latencyMs,
        message,
      );
      return {
        kind: 'schema_invalid',
        errors: [message],
        usage,
        latencyMs,
        costPence: cost,
      };
    }

    const validator = this.validatorFor(input.promptVersion);
    if (!validator(payload)) {
      const errors = (validator.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      );
      await this.logCall(
        input,
        'schema_invalid',
        usage.inputTokens,
        usage.outputTokens,
        latencyMs,
        errors.join('; '),
      );
      return { kind: 'schema_invalid', errors, usage, latencyMs, costPence: cost };
    }

    await this.logCall(input, 'ok', usage.inputTokens, usage.outputTokens, latencyMs, null);
    return { kind: 'ok', payload, usage, latencyMs, costPence: cost };
  }

  private validatorFor(pv: PromptVersionRow): ValidateFunction {
    const cached = this.validators.get(pv.id);
    if (cached) return cached;
    const compiled = this.ajv.compile(pv.output_schema as object);
    this.validators.set(pv.id, compiled);
    return compiled;
  }

  private async send(
    body: ResponsesApiBody,
  ): Promise<
    | { kind: 'ok'; body: ResponsesApiOutput }
    | { kind: 'http_error'; status: number; message: string }
    | { kind: 'timeout'; message: string }
  > {
    const first = await this.sendOnce(body);
    if (first.kind === 'ok') return first;
    if (first.kind === 'http_error' && first.status < 500) return first;
    // One retry on 5xx or network timeout. Schema validation errors
    // never reach this function (the body parsed OK at the HTTP
    // layer) so there is no risk of retrying a malformed body.
    return this.sendOnce(body);
  }

  private async sendOnce(
    body: ResponsesApiBody,
  ): Promise<
    | { kind: 'ok'; body: ResponsesApiOutput }
    | { kind: 'http_error'; status: number; message: string }
    | { kind: 'timeout'; message: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { kind: 'http_error', status: res.status, message: text.slice(0, 500) };
      }
      const json = (await res.json()) as ResponsesApiOutput;
      return { kind: 'ok', body: json };
    } catch (err) {
      const message = (err as Error).message;
      if ((err as Error).name === 'AbortError') {
        return { kind: 'timeout', message };
      }
      return { kind: 'timeout', message };
    } finally {
      clearTimeout(timer);
    }
  }

  private async logCall(
    input: StructuredCallInput,
    status: LlmCallStatus,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    const cost =
      status === 'ok' || status === 'refusal' || status === 'schema_invalid'
        ? costPence(input.promptVersion.model_id, inputTokens, outputTokens)
        : 0;
    await this.repo.insert({
      promptVersionId: input.promptVersion.id,
      attemptPartId: input.attemptPartId,
      modelId: input.promptVersion.model_id,
      inputTokens,
      outputTokens,
      costPence: cost,
      latencyMs,
      status,
      errorMessage,
    });
  }
}
