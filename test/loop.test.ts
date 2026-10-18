import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Llm, runLoop, tool } from "../src/index.js";
import { completion, fakeFetch, toolCall } from "./fakes.js";

const Final = z.object({ found: z.number() });

function search(seen: string[]) {
  return tool({
    name: "search",
    description: "Search the web",
    args: z.object({ q: z.string() }),
    budget: 2,
    run: async ({ q }) => {
      seen.push(q);
      return `results for ${q}`;
    },
  });
}

describe("runLoop", () => {
  it("takes a spent tool out of the list and ends with a structured answer from the log", async () => {
    const seen: string[] = [];
    const { fetch, sent } = fakeFetch([
      () => completion({ tool_calls: [toolCall("1", "search", { q: "a" })] }),
      () => completion({ tool_calls: [toolCall("2", "search", { q: "b" }), toolCall("3", "search", { q: "c" })] }),
      () => completion({ content: '{"found":2}' }),
    ]);
    const r = await runLoop({ llm: new Llm({ baseUrl: "http://gw/v1", model: "m", fetch }), system: "sys", user: "find things", tools: [search(seen)], final: Final });

    expect(seen).toEqual(["a", "b"]);
    expect(r.calls.map((c) => [c.name, c.ok])).toEqual([["search", true], ["search", true], ["search", false]]);
    expect(r.calls[1]!.result).toMatch(/last search call/);
    expect(r.calls[2]!.result).toMatch(/no calls left/);
    expect(r.stopped).toBe("budget");
    expect(r.value).toEqual({ found: 2 });
    // The final call has no tools and gets the log as text.
    const last = sent.at(-1)!.body;
    expect(last.tools).toBeUndefined();
    expect(last.response_format.type).toBe("json_schema");
    expect(last.messages.at(-1).content).toMatch(/#1 search \{"q":"a"\}\nresults for a/);
  });

  it("stops when the model answers in text, and reports bad arguments to it", async () => {
    const seen: string[] = [];
    const { fetch, sent } = fakeFetch([
      () => completion({ tool_calls: [toolCall("1", "search", { query: "x" }), toolCall("2", "nope", {})] }),
      () => completion({ content: "I'm done." }),
      () => completion({ content: '{"found":0}' }),
    ]);
    const r = await runLoop({ llm: new Llm({ baseUrl: "http://gw/v1", model: "m", fetch }), system: "sys", user: "go", tools: [search(seen)], final: Final });
    expect(seen).toEqual([]);
    expect(r.stopped).toBe("answered");
    expect(r.text).toBe("I'm done.");
    expect(r.calls.map((c) => c.result)).toEqual([expect.stringMatching(/invalid arguments: q/), expect.stringMatching(/no tool named nope/)]);
    // A bad call doesn't use up budget: the tool is still offered on the next turn.
    expect(sent[1]!.body.tools[0].function.name).toBe("search");
    expect(sent[1]!.body.messages.filter((m: { role: string }) => m.role === "tool")).toHaveLength(2);
  });

  it("stops at the turn limit", async () => {
    const { fetch } = fakeFetch([(body) => (body.response_format ? completion({ content: '{"found":1}' }) : completion({ tool_calls: [toolCall("1", "free", {})] }))]);
    const free = tool({ name: "free", description: "d", args: z.object({}), run: async () => "ok" });
    const r = await runLoop({ llm: new Llm({ baseUrl: "http://gw/v1", model: "m", fetch }), system: "s", user: "u", tools: [free], final: Final, maxTurns: 3 });
    expect(r.turns).toBe(3);
    expect(r.stopped).toBe("max_turns");
    expect(r.calls).toHaveLength(3);
  });
});
