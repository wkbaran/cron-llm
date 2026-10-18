import { afterEach, describe, expect, it } from "vitest";
import { postDiscord, runJob, splitMessage } from "../src/index.js";
import { fakeFetch, json } from "./fakes.js";

afterEach(() => {
  process.exitCode = 0;
});

describe("splitMessage", () => {
  it("splits at line breaks under the limit", () => {
    const text = ["a".repeat(15), "b".repeat(15), "c".repeat(5)].join("\n");
    expect(splitMessage(text, 20)).toEqual(["a".repeat(15), "b".repeat(15), "ccccc"]);
    expect(splitMessage("x".repeat(45), 20)).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(5)]);
  });
});

describe("postDiscord", () => {
  it("never pings anyone and waits out a 429", async () => {
    const { fetch, sent } = fakeFetch([() => json({ retry_after: 0 }, 429), () => new Response(null, { status: 204 })]);
    await postDiscord("http://hook", "@everyone hi", { fetch });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual({ content: "@everyone hi", allowed_mentions: { parse: [] } });
  });
});

describe("runJob", () => {
  it("posts the returned message", async () => {
    const { fetch, sent } = fakeFetch([() => new Response(null, { status: 204 })]);
    const lines: string[] = [];
    const code = await runJob("digest", async () => "📬 hello", { env: { DISCORD_WEBHOOK_URL: "http://hook" }, argv: [], fetch, write: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(sent.map((s) => s.body.content)).toEqual(["📬 hello"]);
    expect(lines.at(-1)).toMatch(/digest: done in \d+ s, posted 8 characters/);
  });

  it("prints instead of posting on a dry run, and tells the job", async () => {
    const { fetch, sent } = fakeFetch([() => new Response(null, { status: 204 })]);
    const lines: string[] = [];
    let seen: boolean | undefined;
    await runJob(
      "digest",
      async (ctx) => {
        seen = ctx.dryRun;
        return "msg";
      },
      { env: { DISCORD_WEBHOOK_URL: "http://hook" }, argv: ["--dry-run"], fetch, write: (l) => lines.push(l) },
    );
    expect(seen).toBe(true);
    expect(sent).toHaveLength(0);
    expect(lines.at(-1)).toBe("msg");
  });

  it("sends a failure notice to the failure webhook and exits 1", async () => {
    const { fetch, sent } = fakeFetch([() => new Response(null, { status: 204 })]);
    const code = await runJob(
      "digest",
      async () => {
        throw new Error("Medium session expired");
      },
      { env: { DISCORD_WEBHOOK_URL: "http://hook", DISCORD_FAILURE_WEBHOOK_URL: "http://fail" }, argv: [], fetch, write: () => {} },
    );
    expect(code).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(sent).toEqual([{ url: "http://fail", body: { content: "⚠ digest failed: Medium session expired", allowed_mentions: { parse: [] } } }]);
  });

  it("sends nothing when the job returns null", async () => {
    const { fetch, sent } = fakeFetch([() => new Response(null, { status: 204 })]);
    await runJob("digest", async () => null, { env: { DISCORD_WEBHOOK_URL: "http://hook" }, argv: [], fetch, write: () => {} });
    expect(sent).toHaveLength(0);
  });
});
