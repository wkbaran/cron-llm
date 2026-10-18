import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Llm, LlmError, llmFromEnv, StructuredOutputError } from "../src/index.js";
import { completion, fakeFetch, json } from "./fakes.js";

const Gist = z.object({ gist: z.string(), depth: z.number().int().min(1).max(5) });

function llm(f: typeof fetch, extra: Partial<ConstructorParameters<typeof Llm>[0]> = {}) {
  return new Llm({ baseUrl: "http://gw/v1/", apiKey: "k", model: "m", tags: ["job:test"], fetch: f, retries: 1, ...extra });
}

describe("Llm.chat", () => {
  it("sends the model, tags, extra fields and the key, and counts usage", async () => {
    const { fetch, sent } = fakeFetch([() => completion({ content: "hi" })]);
    const client = llm(fetch, { extra: { reasoning_effort: "none" } });
    const r = await client.chat([{ role: "user", content: "hello" }], { tags: ["step:one"], maxTokens: 50 });
    expect(r.message.content).toBe("hi");
    expect(sent[0]!.url).toBe("http://gw/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({ model: "m", reasoning_effort: "none", max_tokens: 50, metadata: { tags: ["job:test", "step:one"] } });
    expect(client.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, calls: 1 });
  });

  it("retries a 5xx, then gives up with the status", async () => {
    const ok = fakeFetch([() => json({ error: "busy" }, 503, { "retry-after": "0" }), () => completion({ content: "ok" })]);
    expect((await llm(ok.fetch).chat([{ role: "user", content: "x" }])).message.content).toBe("ok");
    const bad = fakeFetch([() => json({ error: "nope" }, 400)]);
    const err = await llm(bad.fetch).chat([{ role: "user", content: "x" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(400);
    expect(bad.sent).toHaveLength(1);
  });
});

describe("Llm.structured", () => {
  it("sends the schema as response_format and parses a fenced reply", async () => {
    const { fetch, sent } = fakeFetch([() => completion({ content: '```json\n{"gist":"g","depth":3}\n```' })]);
    expect(await llm(fetch).structured(Gist, { system: "s", user: "u" }, { name: "gist" })).toEqual({ gist: "g", depth: 3 });
    const rf = sent[0]!.body.response_format;
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("gist");
    expect(rf.json_schema.schema.properties.depth).toMatchObject({ type: "integer" });
    expect(rf.json_schema.schema.$schema).toBeUndefined();
    expect(sent[0]!.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("shows the model its error once, then throws with the raw reply", async () => {
    const retry = fakeFetch([() => completion({ content: '{"gist":"g","depth":9}' }), () => completion({ content: '{"gist":"g","depth":4}' })]);
    expect((await llm(retry.fetch).structured(Gist, { user: "u" })).depth).toBe(4);
    expect(retry.sent[1]!.body.messages.at(-1).content).toMatch(/depth: .*5/);

    const never = fakeFetch([() => completion({ content: "not json" })]);
    const err = await llm(never.fetch).structured(Gist, { user: "u" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect((err as StructuredOutputError).raw).toBe("not json");
    expect(never.sent).toHaveLength(2);
  });
});

describe("llmFromEnv", () => {
  it("needs a base URL and model, and maps the reasoning effort", async () => {
    expect(() => llmFromEnv({})).toThrow(/LLM_BASE_URL/);
    const { fetch, sent } = fakeFetch([() => completion({ content: "x" })]);
    await llmFromEnv({ LLM_BASE_URL: "http://gw/v1", LLM_MODEL: "q", LLM_REASONING_EFFORT: "none" }, { fetch }).chat([{ role: "user", content: "x" }]);
    expect(sent[0]!.body).toMatchObject({ model: "q", reasoning_effort: "none" });
  });
});
