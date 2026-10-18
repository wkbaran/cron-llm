<div align="center">

# Cron LLM

**The runtime for scheduled LLM jobs: a digest every morning, a playlist every day.**

![npm](https://img.shields.io/npm/v/cron-llm) ![Node 26+](https://img.shields.io/badge/node-26%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio%20client-6E56CF)
![LLM](https://img.shields.io/badge/LLM-OpenAI--compatible-412991)
![Discord](https://img.shields.io/badge/delivers%20to-Discord-5865F2?logo=discord&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Install](#install) · [What's in it](#whats-in-it) · [Example](#example) · [A tool loop](#a-tool-loop) · [Configuration](#configuration) · [Notes](#notes)

</div>

The code does the work, and the model only judges.

A job built on it is a plain Node script that supercronic (or any cron) starts. It drives MCP servers as child processes, asks the model narrow questions with a JSON schema, and posts the result to Discord. There's no agent framework in between, so there's no framework system prompt, no delegation layer, and no final message for the model to copy by hand. Everything the model sees is a prompt the job wrote.

It came out of moving [Hermes Agent](https://github.com/NousResearch/hermes-agent) cron jobs onto their own containers, after most of their failures turned out to come from the agent layer, not from the jobs.

## Install

Published on npm as [cron-llm](https://www.npmjs.com/package/cron-llm):

```sh
npm install cron-llm zod
```

[Zod](https://zod.dev) is a TypeScript library for describing the shape of data (`z.object({ gist: z.string() })`) and checking values against it, with the TypeScript type inferred from the same definition. cron-llm uses it for every answer it expects back: the schema is turned into JSON Schema for the model's `response_format`, and the reply is checked against it before your code sees it. Install it next to cron-llm for your own schemas; cron-llm uses zod 4.

## What's in it

| Module | Provides |
|---|---|
| `llm` | `Llm`: a client for any OpenAI-compatible `/chat/completions` (a LiteLLM proxy, Ollama, OpenAI). `structured(schema, prompt)` sends a zod schema as `response_format`, validates the reply, and shows the model its error once before giving up. Retries 429s and 5xx. Every request carries `metadata.tags`, which LiteLLM keeps in its spend logs. `extra` adds body fields to every request, or to one call (e.g. `{ reasoning_effort: "medium" }` to let one step think). `llmFromEnv()` |
| `loop` | `runLoop`: a bounded tool loop. Each tool has a budget that the code enforces: a spent tool is taken out of the tool list. The loop ends with one structured call that turns the tool log into your result schema |
| `mcp` | `McpServer.start()`: an MCP server as a stdio child process with only the environment you give it. `call()` returns the tool's text and throws `McpToolError` on `isError`; `callStructured()` returns its `structuredContent`, checked with a zod schema. `asLoopTool()` hands one of its tools to the loop |
| `discord` | `postDiscord`: a webhook post, split at line breaks under Discord's 2000-character cap, with mentions turned off |
| `job` | `runJob(name, fn)`: the entry-point wrapper. Posts what the job returns, sends a short failure notice if it throws, sets the exit code, and supports `--dry-run`. `runJob(name, fn, { username })` posts under a name of your choice |

## Example

```ts
import { McpServer, llmFromEnv, runJob } from "cron-llm";
import { z } from "zod";

await runJob("substack-digest", async ({ log, dryRun }) => {
  const llm = llmFromEnv(process.env, { tags: ["job:substack-digest"], log });
  const server = await McpServer.start({ command: "substack-reader-mcp", env: { SUBSTACK_DIGEST_DIR: "/data" } });
  try {
    const work = await server.call("digest_begin");
    // … read each post, ask the model for a gist …
    const gist = await llm.structured(z.object({ gist: z.string(), depth: z.number().int().min(1).max(5) }), {
      system: "You summarize one post for a daily digest.",
      user: postText,
    });
    // … then let the server save state and lay out the message
    return dryRun ? message : await server.call("digest_finish", { posts });
  } finally {
    await server.close();
  }
});
```

### A tool loop

`runLoop` is for the one step in a job that can't be a single question, such as researching on the web. It's independent of `runJob`; call it wherever the step is. The model calls tools until it answers in text, a budget runs out or the turn limit is reached. Budgets are the loop's, not the prompt's: a tool whose calls are spent is taken out of the model's tool list. One structured call then turns the log of tool calls into your result schema.

```ts
import { runLoop, tool } from "cron-llm";
import { z } from "zod";

const search = tool({
  name: "web_search",
  description: "Search the web. Returns titles, URLs and snippets.",
  args: z.object({ query: z.string() }),
  budget: 20,
  run: async ({ query }) => searchWeb(query), // your function, returning text
});

// A tool from an MCP server, budgeted the same way.
const verify = server.asLoopTool("verify_tracks", {
  description: "Check found tracks on Spotify, one per line.",
  args: z.object({ text: z.string() }),
  budget: 8,
});

const { value, calls, stopped } = await runLoop({
  llm,
  system: "You research new music for one genre.",
  user: "Find 6 to 12 recent tracks that fit … and hand them to verify_tracks.",
  tools: [search, verify],
  final: z.object({ summary: z.string() }),
  finalPrompt: "Sum up the research in one or two sentences.",
  maxTurns: 40,
  log,
});
// stopped: "answered" | "budget" | "max_turns"; calls: every call with its result and whether it ran
```

Arguments are checked against each tool's zod schema before `run` is called. A call over budget, to an unknown tool or with bad arguments gets an error result the model can read, and isn't run. A tool that throws gives the model its error message, and the loop carries on.

## Configuration

| Variable | Used by | |
|---|---|---|
| `LLM_BASE_URL` | `llmFromEnv` | Including `/v1`, e.g. `http://localhost:4000/v1` |
| `LLM_API_KEY` | `llmFromEnv` | Optional |
| `LLM_MODEL` | `llmFromEnv` | The model name the gateway knows |
| `LLM_REASONING_EFFORT` | `llmFromEnv` | Sent as `reasoning_effort`. `none` turns Qwen's thinking off on Ollama |
| `DISCORD_WEBHOOK_URL` | `runJob` | Where the job's message goes. Without it the message is printed |
| `DISCORD_FAILURE_WEBHOOK_URL` | `runJob` | Where failure notices go; defaults to `DISCORD_WEBHOOK_URL` |
| `JOB_DRY_RUN=1` | `runJob` | Same as `--dry-run` |

## Notes

- **Tracing belongs to the gateway.** cron-llm logs one line per call if you pass `log`, and tags every request. Prompts and replies are left to LiteLLM's logs, so they're in one place for every job.
- **Budgets aren't prompts.** Models ignore "stop after 20 searches" (one research subagent made 83). `runLoop` removes the tool instead.
- **Schemas are sent as JSON Schema without `$schema`.** Some servers reject the key. `strict` isn't set, because local servers ignore it and some gateways refuse schemas that don't meet OpenAI's strict rules.

## Development

```sh
npm install
npm test
npm run build
```

Node 26 or later. MIT licensed.
