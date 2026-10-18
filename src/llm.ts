import { z } from "zod";

/**
 * A client for an OpenAI-compatible chat endpoint, usually a LiteLLM proxy.
 * Tracing is the gateway's job: every request carries `metadata.tags`, which
 * LiteLLM records in its spend logs, so a job's calls can be found there.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatResult {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: string;
  usage: Usage;
}

export interface ChatOptions {
  tools?: ToolSpec[];
  responseFormat?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /** Added to the client's tags for this call only. */
  tags?: string[];
}

export interface LlmOptions {
  /** Base URL including `/v1`, e.g. `http://localhost:4000/v1`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Sent as LiteLLM `metadata.tags` on every request. */
  tags?: string[];
  /** Per request. Local models can be slow; the default is 5 minutes. */
  timeoutMs?: number;
  /** Retries after a 429, a 5xx or a network error. */
  retries?: number;
  /** Extra body fields on every request, e.g. `{ reasoning_effort: "none" }` to turn Qwen's thinking off. */
  extra?: Record<string, unknown>;
  /** One line per call (model, tokens, time); off by default. */
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The model's reply didn't match the schema, even after it was shown the error. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

export class Llm {
  readonly model: string;
  private readonly opts: LlmOptions;
  /** Totals over the client's lifetime, for a job's closing log line. */
  readonly usage: Usage & { calls: number } = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };

  constructor(opts: LlmOptions) {
    this.opts = opts;
    this.model = opts.model;
  }

  async chat(messages: Message[], opts: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      ...this.opts.extra,
      metadata: { tags: [...(this.opts.tags ?? []), ...(opts.tags ?? [])] },
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const started = Date.now();
    const json = await this.post(body);
    const choice = json.choices?.[0];
    if (!choice?.message) throw new LlmError(`No choices in the response: ${JSON.stringify(json).slice(0, 300)}`);
    const usage: Usage = { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: json.usage?.completion_tokens ?? 0 };
    this.usage.prompt_tokens += usage.prompt_tokens;
    this.usage.completion_tokens += usage.completion_tokens;
    this.usage.calls++;
    this.opts.log?.(`llm ${this.opts.model}: ${usage.prompt_tokens} in, ${usage.completion_tokens} out, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const m = choice.message;
    return {
      message: { role: "assistant", content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
      finishReason: choice.finish_reason ?? "",
      usage,
    };
  }

  /**
   * Ask for JSON matching `schema`. The schema is sent as `response_format`
   * (constrained decoding where the model server supports it) and the reply is
   * validated with zod. A reply that fails is shown back to the model with the
   * error, up to `attempts` tries in all.
   */
  async structured<S extends z.ZodType>(
    schema: S,
    prompt: { system?: string; user: string } | Message[],
    opts: { name?: string; attempts?: number; maxTokens?: number; temperature?: number; tags?: string[] } = {},
  ): Promise<z.infer<S>> {
    const messages: Message[] = Array.isArray(prompt)
      ? [...prompt]
      : [...(prompt.system ? [{ role: "system" as const, content: prompt.system }] : []), { role: "user", content: prompt.user }];
    const responseFormat = { type: "json_schema", json_schema: { name: opts.name ?? "answer", schema: jsonSchema(schema) } };
    const attempts = opts.attempts ?? 2;
    let raw = "";
    for (let i = 1; ; i++) {
      const { message } = await this.chat(messages, { responseFormat, maxTokens: opts.maxTokens, temperature: opts.temperature, tags: opts.tags });
      raw = message.content ?? "";
      const problem = check(schema, raw);
      if (problem.ok) return problem.value;
      if (i >= attempts) throw new StructuredOutputError(`The reply didn't match the schema after ${attempts} tries: ${problem.error}`, raw);
      messages.push({ role: "assistant", content: raw }, { role: "user", content: `That reply isn't valid: ${problem.error}. Reply again with only the JSON object.` });
    }
  }

  private async post(body: Record<string, unknown>): Promise<any> {
    const doFetch = this.opts.fetch ?? fetch;
    const retries = this.opts.retries ?? 2;
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new LlmError(`Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 && after <= 60 ? after * 1000 : backoff(attempt));
        continue;
      }
      throw new LlmError(`${url} returned ${res.status}: ${text.slice(0, 500)}`, res.status);
    }
  }
}

/** A client from `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and optional `LLM_REASONING_EFFORT`. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env, opts: Partial<LlmOptions> = {}): Llm {
  const baseUrl = env.LLM_BASE_URL;
  const model = env.LLM_MODEL;
  if (!baseUrl || !model) throw new Error("Set LLM_BASE_URL (for example http://localhost:4000/v1) and LLM_MODEL.");
  const effort = env.LLM_REASONING_EFFORT;
  return new Llm({
    baseUrl,
    model,
    apiKey: env.LLM_API_KEY,
    ...opts,
    extra: { ...(effort ? { reasoning_effort: effort } : {}), ...opts.extra },
  });
}

/** The JSON Schema for `response_format`, without the `$schema` key some servers reject. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  return rest;
}

function check<S extends z.ZodType>(schema: S, raw: string): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { ok: false, error: "it isn't JSON" };
  }
  const r = schema.safeParse(parsed);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

/** Models sometimes wrap JSON in a ```json fence even when told not to. */
function stripFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1]! : s.trim();
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
